import {
  JupyterLab, JupyterLabPlugin
} from '@jupyterlab/application';

import {
  ICommandPalette
} from '@jupyterlab/apputils';

import {
  IMainMenu
} from '@jupyterlab/mainmenu';

import {
  INotebookTracker
} from '@jupyterlab/notebook';

import { 
  IEditorTracker
} from '@jupyterlab/fileeditor';

import {
  IStateDB
} from '@jupyterlab/coreutils';

import {
  Terminal
} from '@jupyterlab/terminal';

import {
  Cell // ICellModel
} from '@jupyterlab/cells';

import {
  CodeMirrorEditor
} from '@jupyterlab/codemirror';

import * as CodeMirror from 'codemirror';

// CSS
import '../style/index.css';

// extension id
const id = `jupyterlab-flake8`;

class Preferences {
  toggled:Boolean = true;                // turn on/off linter
  logging:Boolean = false;               // turn on/off logging
  highlight_color:string = 'yellow';    // color of highlights
  show_error_messages: Boolean = true;    // show error message
  termTimeout:number = 5000;             // seconds before the temrinal times out if it has not received a message
}
/**
 * Linter
 */
class Linter {
  app: JupyterLab;
  notebookTracker: INotebookTracker;
  editorTracker: IEditorTracker;
  palette: ICommandPalette;
  mainMenu: IMainMenu;
  state: IStateDB;
  term: Terminal;
  
  prefsKey = `${id}:preferences`;

  // Default Options
  prefs =  new Preferences();

  // flags
  loaded: boolean = false;              // flag if flake8 is available
  linting: boolean = false;             // flag if the linter is processing
  termTimeoutHandle: number;            // flag if the linter is processing

  // notebook
  cell_text: Array<string>;           // current nb cells
  cells: Array<any>;                  // widgets from notebook
  notebook: any;                      // current nb cells
  lookup: any;                        // lookup of line index

  // editor
  editor: any;                        // current file editor widget
  editortext: any;                    // current file editor text

  // cache
  cache: Array<any> = [];            // cache for messages
  marks: Array<CodeMirror.TextMarker> = []; // text marker objects currently active
  bookmarks: Array<any> = [];         // text marker objects currently active
  text: string = '';                // current nb text
  process_mark: Function;           // default line marker processor

  constructor(app: JupyterLab, 
              notebookTracker: INotebookTracker,
              editorTracker: IEditorTracker,
              palette: ICommandPalette, 
              mainMenu: IMainMenu,
              state: IStateDB,
              ){
   
    this.app = app;
    this.mainMenu = mainMenu;
    this.notebookTracker = notebookTracker;
    this.editorTracker = editorTracker;
    this.palette = palette;
    this.state = state;

    // Load the saved plugin state and apply it once the app
    // has finished restoring its former layout.
    Promise.all([this.state.fetch(this.prefsKey), app.restored])
      .then(([savedPrefs]) => {
        try {
          let prefs:Preferences = JSON.parse(<any>savedPrefs);
          Object.keys(prefs).forEach((key:string) => {
            (<any>this.prefs)[key] = (<any>prefs)[key];
          });
          this.log(`loaded preferences`);
        } catch(e) {
          this.log(`Failed to load preferences`);
        }
      });

    // activate function when cell changes
    this.notebookTracker.currentChanged.connect(this.onActiveNotebookChanged, this);

    // activate when editor changes
    this.editorTracker.currentChanged.connect(this.onActiveEditorChanged, this);

    // add menu item
    this.add_commands();

    // if the linter is enabled, load it
    if (this.prefs.toggled) {
      this.load_linter();
    }
  }

  /**
   * Load terminal session and flake8
   */
  async load_linter(){

    // Bail if there are no terminals available.
    if (!this.app.serviceManager.terminals.isAvailable()) {
      this.log('Disabling jupyterlab-flake8 plugin because it cant access terminal');
      this.loaded = false;
      this.prefs.toggled = false;
      return;
    }

    this.term = new Terminal({initialCommand: 'echo "Opening flake8 terminal"'});
    try {
      this.term.session = await this.app.serviceManager.terminals.startNew();

      // wait 4 seconds for terminal to load and get initial commands out of its system
      setTimeout(() => {
        this.loaded = true;
        this.activate_flake8();
      }, 4000)
    }
    catch(e) {
      this.loaded = false;
      this.prefs.toggled = false;
      this.term.dispose();
      this.term = undefined;
    }
  }


  /**
   * Activate flake8 terminal reader
   */
  activate_flake8() {
    // listen for stdout in onLintMessage
    this.term.session.messageReceived.connect(this.onLintMessage, this);
  }

  /**
   * Dispose of the terminal used to lint
   */
  dispose_linter() {
    this.log(`disposing flake8 and terminal`);
    this.lint_cleanup();
    this.clear_marks();

    if (this.term) {
      this.term.session.messageReceived.disconnect(this.onLintMessage, this); 
      this.term.dispose();
    }
  }

  /**
   * load linter when notebook changes
   */
  private onActiveNotebookChanged(): void {
    // return if file is being closed
    if (!this.notebookTracker.currentWidget) {
      return;
    }

    // select the notebook
    this.notebook = this.notebookTracker.currentWidget.content;

    // run on cell changing
    // this.notebookTracker.activeCellChanged.disconnect(this.onActiveCellChanged, this);
    // this.notebookTracker.activeCellChanged.connect(this.onActiveCellChanged, this);

    // run on stateChanged
    this.notebook.model.stateChanged.disconnect(this.onActiveCellChanged, this);
    this.notebook.model.stateChanged.connect(this.onActiveCellChanged, this);
  }

  /**
   * Run linter when active cell changes
   */
  private onActiveCellChanged(): void {
    if (this.loaded && this.prefs.toggled) {
      if (!this.linting) {
        this.lint_notebook();
      } else {
        this.log('flake8 is already running onActiveCellChanged');
      }
    }
  }


  /**
   * load linter when active editor loads
   */
  private onActiveEditorChanged(): void {
    // return if file is being closed
    if (!this.editorTracker.currentWidget) {
      return;
    }

    // select the editor
    this.editor = this.editorTracker.currentWidget.content;

    // run on stateChanged
    this.editor.model.stateChanged.disconnect(this.onActiveEditorChanges, this);
    this.editor.model.stateChanged.connect(this.onActiveEditorChanges, this);

  }

  /**
   * Run linter on active editor changes
   */
  private onActiveEditorChanges(): void {
    if (this.loaded && this.prefs.toggled) {
      if (!this.linting) {
        this.lint_editor();
      } else {
        this.log('flake8 is already running onEditorChanged');
      }
    }
  }

  /**
   * Generate lint command
   * 
   * @param  {string} contents - contents of the notebook ready to be linted
   * @return {string} [description]
   */
  lint_cmd(contents:string): string {
    let escaped = contents.replace(/["`]/g,'\\$&');
    escaped = escaped.replace('\r','');  // replace carriage returns
    return `(echo "${escaped}" | flake8 --exit-zero - && echo "@jupyterlab-flake8 finished linting" ) || (echo "@jupyterlab-flake8 finished linting failed")`
  }

  /**
   * Determine if text is input
   * @param {string} text [description]
   */
  private text_exists(text:string) {
    return text;
    // return text && text !== '\n' && text !== '\n\n';
  }

  /**
   * Clear all current marks from code mirror
   */
  private clear_marks() {
    this.marks.forEach((mark:CodeMirror.TextMarker) => {
      mark.clear();
    });

    // clear error messages as well
    this.clear_error_messages();

    // clear cache
    this.cache = [];
  }

  /**
   * Clear all error messages
   */
  private clear_error_messages() {
    this.bookmarks.forEach((bookmark:any) => {
      bookmark.clear();
    });
  }

  /**
   * Lint the CodeMirror Editor
   */
  lint_editor() {
    this.linting = true;  // no way to turn this off yet
    this.process_mark = this.mark_editor;

    this.log('getting editor text');

    // catch if file is not a .py file
    if (this.editor.model._defaultLang !== 'python') {
      this.log(`not python default lang`);
      this.lint_cleanup();
      return;
    }

    let pytext = this.editor.model.value.text;
    this.lint(pytext);
  }

  /**
   * mark the editor pane
   * @param {number} line    [description]
   * @param {number} ch      [description]
   * @param {string} message [description]
   */
  mark_editor(line:number, ch:number) {
    this.log(`marking editor`);

    line = line - 1; // 0 index
    ch = ch - 1;  // not sure

    // get lines
    let from = {line: line, ch: ch};
    let to = {line: line, ch: ch+1};

    // get code mirror editor
    let doc = this.editor.editorWidget.editor.doc;

    return [doc, from, to];
  }

  /**
   * Run flake8 linting on notebook cells
   */
  lint_notebook() {
    this.linting = true;  // no way to turn this off yet
    this.process_mark = this.mark_notebook;

    // load notebook
    this.cells = this.notebook.widgets;
    
    this.log('getting notebook text');

    // return text from each cell if its a code cell
    this.cell_text = this.cells
      .map((cell:any, cell_idx:number, cell_arr: any[]) => {
        if (cell.model.type === 'code' && this.text_exists(cell.model.value.text)) {

          // append \n\n if its not the last cell
          if (cell_idx !== cell_arr.length - 1) {
            return `${cell.model.value.text}\n\n`;
          } else {
            return cell.model.value.text;
          }

        } else {
          return '';
        }
      });

    // create dictionary of lines
    this.lookup = {};
    let line = 1;
    this.cell_text.map((cell:any, cell_idx:number, cell_arr:any[]) => {

      // if there is text in the cell,
      if (this.text_exists(cell)) {
        let lines = cell.split('\n');
        for (let idx = 0; idx < lines.length-1; idx++) {
          this.lookup[line] = {
            cell: cell_idx,
            line: idx
          };
          line += 1;
        }
      }

      // if its the last cell in the notebook and its empty
      else if (cell_idx === cell_arr.length-1) {
        this.lookup[line] = {
          cell: cell_idx,
          line: 0
        }
      }
    });

    // join cells with text with two new lines
    let pytext =  this.cell_text.join('');

    // run linter
    this.lint(pytext);
  }

  /**
   * mark the line of the cell
   * @param {number} line    the line # returned by flake8
   * @param {number} ch      the character # returned by flake 8
   */
  mark_notebook(line:number, ch:number) {
    let loc = this.lookup[line];
    ch = ch - 1;  // make character 0 indexed

    if (!loc) {
      return;
    }
   
    let from = {line: loc.line, ch: ch};
    let to = {line: loc.line, ch: ch+1};

    // get cell instance
    let cell:Cell = this.notebook.widgets[loc.cell];

    // get cell's code mirror editor
    let editor:CodeMirrorEditor = cell.inputArea.editorWidget.editor as CodeMirrorEditor;
    let doc = editor.doc;

    return [doc, from, to];
  }


  /**
   * Lint a python text message and callback marking function with line and character
   * @param {string}   pytext        [description]
   */
  lint(pytext:string) {

    // cache pytext on text
    if (pytext !== this.text) {
      this.text = pytext;
    } else {  // text has not changed
      this.log('text unchanged');
      this.lint_cleanup();
      return;
    }

    // TODO: handle if text is empty (any combination of '' and \n)
    if (!this.text_exists(this.text)) {
      this.log('text empty');
      this.lint_cleanup();
      return;
    }

    // clean current marks
    this.clear_marks();

    // get lint command to run in terminal and send to terminal
    this.log('preparing lint command');
    let lint_cmd = this.lint_cmd(pytext);
    this.log('sending lint command');
    this.term.session.send({type: 'stdin', content: [`${lint_cmd}\r`]})
    this.termTimeoutHandle = setTimeout(() => {
      if (this.linting = true) {
        this.log('lint command timed out');
        alert('jupyterlab-flake8 ran into an issue connecting with the terminal. Please try re-enabling the linter');
        this.lint_cleanup();
        this.dispose_linter();
        this.prefs.toggled = false;
      }
    }, this.prefs.termTimeout)
  }

  /**
   * Handle terminal message during linting
   * TODO: import ISession and IMessage types for sender and msg
   * @param {any} sender [description]
   * @param {any} msg    [description]
   */
  onLintMessage(sender:any, msg:any): void {
    clearTimeout(this.termTimeoutHandle)
    if (msg.content) {
      let message:string = msg.content[0] as string;
      this.log(`terminal message: ${message}`);

      // if message a is a reflection of the command, return
      if (message.indexOf('Traceback') > -1) {
        alert(`Flake8 encountered a python error. Make sure flake8 is installed and on the system path. \n\nTraceback: ${message}`);
        this.lint_cleanup();
        return;
      }

      // if message a is a reflection of the command, return
      if (message.indexOf('command not found') > -1 ) {
        alert(`Flake8 was not found in this python distribution. \n\nInstall with 'pip install flake8' or 'conda install flake8' and reload the jupyterlab window`);
        this.lint_cleanup();
        return;
      }

      message.split('\n').forEach(m => {
        if (m.includes('stdin:')) {
          let idxs = m.split(':');
          let line = parseInt(idxs[1]);
          let ch = parseInt(idxs[2]);
          this.get_mark(line, ch, idxs[3]);
        }
      });

      if (message.indexOf('jupyterlab-flake8 finished linting') > -1) {
        this.lint_cleanup();
      }

    }
  }

  /**
   * Mark a line in notebook or editor
   * @param {number} line    [description]
   * @param {number} ch      [description]
   * @param {string} message [description]
   */
  get_mark(line:number, ch:number, message:string) {

    let doc, from, to;
    if (this.process_mark) {
      [doc, from, to] = this.process_mark(line, ch);
    }

    if (!doc || !from || !to) {
      this.log(`mark location not fully defined`);
      return;
    }

    // cache mark
    this.cache.push({
      doc: doc,
      from: from,
      to: to,
      message: message
    });

    this.mark_line(doc, from, to, message);
  }


  /**
   * Mark line in document
   * @param {any}    doc     [description]
   * @param {any}    from    [description]
   * @param {any}    to      [description]
   * @param {string} message [description]
   */
  private mark_line(doc:any, from:any, to:any, message:string) {

    // mark the text
    this.marks.push(doc.markText(from, to,
      {
        // replacedWith: selected_char_node,
        className: 'jupyterlab-flake8-lint-message',
        css: `
          background-color: ${this.prefs.highlight_color}
        `
      }));

    // TODO: show this is a hover-over bubble
    // create error alert node
    if (this.prefs.show_error_messages) {
      let lint_alert = document.createElement('span');
      let lint_message = document.createTextNode(`------ ${message}`);
      lint_alert.appendChild(lint_message);
      lint_alert.className = 'jupyterlab-flake8-lint-message';  

      // add error alert node to the 'to' location
      this.bookmarks.push(
        (<any>doc).addLineWidget(from.line, lint_alert)
      );
    }

    // this.bookmarks.push(doc.setBookmark({line: loc.lin, ch: ch}, {
    //   widget: lint_alert
    // }));
    // 

    // window debugging
    // (<any>window).editor = editor;
    // (<any>window).doc = doc;
    // (<any>window).notebook = this.notebook;
    // (<any>window).cell = this.notebook.widgets[loc.cell];
    // (<any>window).CodeMirror = CodeMirror
  }

  /**
   * Tear down lint fixtures
   */
  lint_cleanup() {
    this.linting = false;
    // this.process_mark = undefined;  
  }

  /**
   * Show browser logs
   * @param {any} msg [description]
   */
  log(msg:any) {

    // return if prefs.logging is not enabled
    if (!this.prefs.logging) {
      return;
    }

    // convert object messages to strings
    if (typeof(msg) === 'object') {
      msg = JSON.stringify(msg);
    }

    // prepend name
    let output = `jupyterlab-flake8: ${msg}`;
    console.log(output);
  }

    /**
   * Turn linting on/off
   */
  toggle_linter(){
    this.prefs.toggled = !this.prefs.toggled;

    if (this.prefs.toggled) {
      this.load_linter();
    } else {
      this.dispose_linter();
    }
  }

  /**
   * Turn error messages on/off
   */
  toggle_error_messages(){
    this.prefs.show_error_messages = !this.prefs.show_error_messages;

    if (!this.prefs.show_error_messages) {
      this.clear_error_messages();
    } else if (this.cache && this.cache.length > 0) {
      this.cache.forEach((mark) => {
        this.mark_line(mark.doc, mark.from, mark.to, mark.message);
      });
    }
  }

  /**
   * Create menu / command items
   */
  add_commands(){
    let category = 'Flake8';

    // define all commands
    let commands:any = {
      'flake8:toggle': {
        label: "Enable Flake8",
        isEnabled: () => { return this.loaded},
        isToggled: () => { return this.prefs.toggled},
        execute: () => {
          this.toggle_linter();
          this.savePreferences();
        } 
      },
      'flake8:show_error_messages': {
        label: "Show Flake8 Error Messages",
        isEnabled: () => { return this.loaded},
        isToggled: () => { return this.prefs.show_error_messages},
        execute: () => {
          this.toggle_error_messages();
          this.savePreferences();
        } 
      },
      'flake8:show_browser_logs': {
        label: "Output Flake8 Browser Console Logs",
        isEnabled: () => { return this.loaded},
        isToggled: () => { return this.prefs.logging},
        execute: () => {
          this.prefs.logging = !this.prefs.logging;
          this.savePreferences();
        } 
      },
    };

    // add commands to menus and palette
    for (let key in commands) {
      this.app.commands.addCommand(key, commands[key]);
      this.palette.addItem({command: key, category: category} );
    }

    // add to view Menu
    this.mainMenu.viewMenu.addGroup(Object.keys(commands).map(key => {return {command: key} }), 30);
  }

  /**
   * Save state preferences
   */
  private savePreferences() {
    this.state.save(`${this.prefsKey}`, JSON.stringify(this.prefs));
    this.log(`saved preferences: ${JSON.stringify(this.prefs)}`);
  }

}


/**
 * Activate extension
 */
function activate(app: JupyterLab, 
                  notebookTracker: INotebookTracker,
                  editorTracker: IEditorTracker,
                  palette: ICommandPalette, 
                  mainMenu: IMainMenu,
                  state: IStateDB
                  ) {

  new Linter(app, notebookTracker, editorTracker, palette, mainMenu, state);

};


/**
 * Initialization data for the jupyterlab-flake8 extension.
 */
const extension: JupyterLabPlugin<void> = {
  id: 'jupyterlab-flake8',
  autoStart: true,
  activate: activate,
  requires: [INotebookTracker, IEditorTracker, ICommandPalette, IMainMenu, IStateDB]
};

export default extension;
