import {
  JupyterLab, JupyterLabPlugin
} from '@jupyterlab/application';

import {
  ICommandPalette
} from '@jupyterlab/apputils';

import {
  CodeMirrorEditor
} from '@jupyterlab/codemirror';

import {
  IMainMenu
} from '@jupyterlab/mainmenu';

import {
  INotebookTracker
} from '@jupyterlab/notebook';

import {
  Terminal
} from '@jupyterlab/terminal';

import {
  Cell // ICellModel
} from '@jupyterlab/cells';

// TODO: why import CodeMirror from here?
import * as CodeMirror from 'codemirror';

// CSS
import '../style/index.css';

/**
 * Linter
 */
class Linter {
  app: JupyterLab;
  tracker: INotebookTracker;
  palette: ICommandPalette;
  mainMenu: IMainMenu;
  term: Terminal;

  // Default Options
  loaded: boolean = false;                // if flake8 is available
  toggled: boolean = true;                // turn on.off linter
  logging: boolean = false;                // turn on.off linter
  highlight_color: string = 'yellow';     // color of highlights
  show_error_messages: boolean = true;            // show error message

  // flags
  linting: boolean = false;          // flag if the linter is processing

  // cache
  cell_text: Array<string>;           // current nb cells
  cells: Array<any>;                  // widgets from notebook
  notebook: any;                      // current nb cells
  lookup: any;                        // lookup of line index
  nbtext: string = '';                // current nb text
  marks: Array<CodeMirror.TextMarker> = []; // text marker objects currently active
  bookmarks: Array<any> = [];         // text marker objects currently active

  constructor(app: JupyterLab, 
              tracker: INotebookTracker, 
              palette: ICommandPalette, 
              mainMenu: IMainMenu){
   
    this.app = app;
    this.mainMenu = mainMenu;
    this.tracker = tracker;
    this.palette = palette;

    // activate function when cell changes
    this.tracker.activeCellChanged.connect(this.onActiveCellChanged, this);

    // add menu item
    this.add_commands();

    // if the linter is enabled, load it
    if (this.toggled) {
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
      this.toggled = false;
      return;
    }

    this.term = new Terminal();
    try {
      this.term.session = await this.app.serviceManager.terminals.startNew();

      // wait 2 seconds for terminal to load and get initial commands out of its system
      setTimeout(() => {
        this.loaded = true;
        this.activate_flake8();
      }, 4000)
    }
    catch(e) {
      this.term.dispose();
      this.term = undefined;
    }
  }

  /**
   * Check to see if flake8 is available on the machine
   * @deprecated for now
   */
  check_flake8() {
    let self = this;

    // need to figure out how to import ISession and IMessage
    function onTerminalMessage(sender:any, msg:any): void {
      let message:string = msg.content[0];
      this.log(`terminal message: ${message}`);

      // return if its just a message reflection
      if (message.indexOf('which flake8') > -1) {
        return;
      }

      // if message includes flake8, then `which flake8` was successful and we can say the library is loaded
      if (message.indexOf('flake8') > -1) {
        self.loaded = true;
        self.activate_flake8();
      } else {
        alert('Flake8 was not found in this python distribution. \n\nInstall with `pip install flake8` or `conda install flake8` and reload the jupyterlab window')
        self.loaded = false;
      }

      // remove this listener from the terminal session
      self.term.session.messageReceived.disconnect(onTerminalMessage, this)
    }

    // listen for stdout in onTerminalMessage and ask `which flake8`
    this.term.session.messageReceived.connect(onTerminalMessage, this);
    this.term.session.send({type: 'stdin', content: ['which flake8\r']})
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
    this.clear_marks();

    if (this.term) {
      this.term.session.messageReceived.disconnect(this.onLintMessage, this); 
      this.term.dispose();
    }
  }

  /**
   * Turn linting on/off
   */
  toggle_linter(){
    this.toggled = !this.toggled;

    if (this.toggled) {
      this.load_linter();
    } else {
      this.dispose_linter();
    }
  }

  /**
   * Turn error messages on/off
   */
  toggle_error_messages(){
    this.show_error_messages = !this.show_error_messages;

    if (!this.show_error_messages) {
      this.clear_error_messages();
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
        isToggled: () => { return this.toggled},
        execute: () => {
          this.toggle_linter();
        } 
      },
      'flake8:show_error_messages': {
        label: "Show Flake8 Error Messages",
        isEnabled: () => { return this.loaded},
        isToggled: () => { return this.show_error_messages},
        execute: () => {
          this.toggle_error_messages();
        } 
      },      
      'flake8:show_browser_logs': {
        label: "Output Flake8 Browser Console Logs",
        isEnabled: () => { return this.loaded},
        isToggled: () => { return this.logging},
        execute: () => {
          this.logging = !this.logging;
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
   * Run linter when active cell changes
   */
  private onActiveCellChanged(): void {
    if (this.loaded && this.toggled) {
      if (!this.linting) {
        this.lint();
      } else {
        this.log('flake8 is already running onActiveCellChanged');
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
    let escaped = contents.replace(/([!{}"'$`\\])/g,'\\$1');
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
   * Run flake8 linting on notebook cells
   */
  lint() {
    this.linting = true;  // no way to turn this off yet

    // load notebook
    this.notebook = this.tracker.currentWidget.notebook;
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

    // cache pytext on nbtext
    if (pytext !== this.nbtext) {
      this.nbtext = pytext;
    } else {  // text has not changed
      this.log('notebook text unchanged');
      this.linting = false;
      return;
    }

    // TODO: handle if text is empty (any combination of '' and \n)
    if (!this.text_exists(this.nbtext)) {
      this.log('notebook text empty');
      this.linting = false;
      return;
    }

    // clean current marks
    this.clear_marks();

    // get lint command to run in terminal and send to terminal
    this.log('preparing lint command');
    let lint_cmd = this.lint_cmd(pytext);
    this.log('sending lint command');
    this.term.session.send({type: 'stdin', content: [`${lint_cmd}\r`]})
  }

  /**
   * Handle terminal message during linting
   * TODO: import ISession and IMessage types for sender and msg
   * @param {any} sender [description]
   * @param {any} msg    [description]
   */
  onLintMessage(sender:any, msg:any): void {
    if (msg.content) {
      let message:string = msg.content[0] as string;
      this.log(`terminal message: ${message}`);

      // if message a is a reflection of the command, return
      if (message.indexOf('Traceback') > -1) {
        alert(`Flake8 encountered a python error. Make sure flake8 is installed and on the system path. \n\nTraceback: ${message}`);
        this.linting = false;
        return;
      }

      // if message a is a reflection of the command, return
      if (message.indexOf('command not found') > -1 ) {
        alert(`Flake8 was not found in this python distribution. \n\nInstall with 'pip install flake8' or 'conda install flake8' and reload the jupyterlab window`);
        this.linting = false;
        return;
      }

      message.split('\n').forEach(m => {
        if (m.includes('stdin:')) {
          let idxs = m.split(':');
          let line = parseInt(idxs[1]);
          let ch = parseInt(idxs[2]);
          this.mark_line(line, ch, idxs[3]);
        }
      });

      if (message.indexOf('jupyterlab-flake8 finished linting') > -1) {
        this.linting = false;
      }

    }
  }


  /**
   * mark the line of the cell
   * @param {number} line    the line # returned by flake8
   * @param {number} ch      the character # returned by flake 8
   * @param {string} message the flak8 error message
   */
  mark_line(line:number, ch:number, message:string) {
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

    // mark the text
    this.marks.push(doc.markText(from, to,
      {
        // replacedWith: selected_char_node,
        className: 'jupyterlab-flake8-lint-message',
        css: `
          background-color: ${this.highlight_color}
        `
      }));

    // TODO: show this is a hover-over bubble
    // create error alert node
    if (this.show_error_messages) {
      let lint_alert = document.createElement('span');
      let lint_message = document.createTextNode(`------ ${message}`);
      lint_alert.appendChild(lint_message);
      lint_alert.className = 'jupyterlab-flake8-lint-message';  

      // add error alert node to the 'to' location
      this.bookmarks.push(
        (<any>doc).addLineWidget(loc.line, lint_alert)
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
   * Show browser logs
   * @param {any} msg [description]
   */
  log(msg:any) {

    // return if logging is not enabled
    if (!this.logging) {
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

}


/**
 * Activate extension
 */
function activate(app: JupyterLab, 
                  tracker: INotebookTracker, 
                  palette: ICommandPalette, 
                  mainMenu: IMainMenu) {

  new Linter(app, tracker, palette, mainMenu);

};


/**
 * Initialization data for the jupyterlab-flake8 extension.
 */
const extension: JupyterLabPlugin<void> = {
  id: 'jupyterlab-flake8',
  autoStart: true,
  activate: activate,
  requires: [INotebookTracker, ICommandPalette, IMainMenu]
};

export default extension;
