import {
  JupyterLab, JupyterLabPlugin
} from '@jupyterlab/application';

import {
  INotebookTracker
} from '@jupyterlab/notebook';

import {
  IMainMenu
} from '@jupyterlab/mainmenu';

import {
  ICommandPalette
} from '@jupyterlab/apputils';

import {
  Terminal
} from '@jupyterlab/terminal';

// TODO: figure out whats going on with code mirror
import * as CodeMirror from 'codemirror';
// import * as CodeMirror from '@jupyterlab/codemirror';

// import {
//   IEditorServices
//   // , CodeEditor
// } from '@jupyterlab/codeeditor';

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
  loaded: boolean = false;          // if flake8 is available
  toggled: boolean = true;          // turn on.off linter

  linting: boolean = false;          // flag if the linter is processing

  // cache
  cell_text: Array<string>;           // current nb cells
  cells: Array<any>;                  // widgets from notebook
  notebook: any;                      // current nb cells
  lookup: any;                        // lookup of line index
  nbtext: string = '';                // current nb text

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
      console.log('Disabling jupyterlab-flake8 plugin because it cant access terminal');
      this.loaded = false;
      this.toggled = false;
      return;
    }

    this.term = new Terminal();
    try {
      this.term.session = await this.app.serviceManager.terminals.startNew();
      console.log('loaded terminal session');

      // wait 2 seconds for terminal to load and get initial commands out of its system
      setTimeout(() => {
        this.check_flake8();
      }, 2000)
    }
    catch(e) {
      this.term.dispose();
      this.term = undefined;
    }
  }

  /**
   * Check to see if flake8 is available on the machine
   */
  check_flake8() {
    let self = this;

    // need to figure out how to import ISession and IMessage
    function onTerminalMessage(sender:any, msg:any): void {
      let message:string = msg.content[0];
      console.log(message);

      // return if its just a message reflection
      if (message.includes('which flake8')) {
        return;
      }

      // if message includes flake8, then `which flake8` was successful and we can say the library is loaded
      if (message.includes('flake8')) {
        self.loaded = true;
        self.activate_flake8();
      } else {
        alert('Flake8 was not found on the machine. \n\nInstall with `pip install flake8` or `conda install flake8`')
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
    if (this.term) {
      this.term.session.messageReceived.disconnect(this.onLintMessage, this); 
      this.term.dispose();
      console.log('disposed terminal');
    } else {
      console.log('no terminal to dispose');
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
   * Create menu / command items
   */
  add_commands(){
    let category = 'Flake8';

    // define all commands
    let commands:any = {
      'flake8:toggle': {
        label: "Toggle flake8",
        isEnabled: () => { return this.loaded},
        isToggled: () => { return this.toggled},
        execute: () => {
          this.toggle_linter();
        } 
      }
    };

    // add commands to menus and palette
    for (let key in commands) {
      this.app.commands.addCommand(key, commands[key]);
      this.palette.addItem({command: key, category: category} );
      this.mainMenu.viewMenu.addGroup([
        { command: key }
      ], 30);      
    }
  }

  /**
   * Run linter when active cell changes
   */
  onActiveCellChanged(): void {
    if (this.loaded && this.toggled) {
      if (!this.linting) {
        this.lint();
      } else {
        console.log('already linting');
      }
    }
  }

  /**
   * Generate lint command
   * 
   * @param  {string} contents [description]
   * @return {string} [description]
   */
  lint_cmd(contents:string): string {
    // let escaped = contents.replace(/(["\s'$`\\])/g,'\\$1');
    let escaped = contents.replace('"', '\"');
    return `echo "${escaped}" | flake8 -`
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
   * Run flake8 linting on notebook cells
   */
  lint() {
    this.linting = true;  // no way to turn this off yet

    // load notebook
    this.notebook = this.tracker.currentWidget.notebook;
    this.cells = this.notebook.widgets;

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
      // .filter((cell:any) => {return cell});


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
      this.linting = false;
      return;
    }

    // TODO: handle if text is empty (any combination of '' and \n)
    if (!this.text_exists(this.nbtext)) {
      this.linting = false;
      return;
    }

    console.log(`nbtext: ${this.nbtext}`);

    let lint_cmd = this.lint_cmd(pytext);
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

      // if message a is a reflection of the command, return
      if (message.includes('| f l a k e 8')) {
        return;
      }

      console.log(`stdout: ${message}`);

      message.split('\n').forEach(m => {
        if (m.includes('stdin:')) {
          let idxs = m.split(':');
          let line = parseInt(idxs[1]);
          let row = parseInt(idxs[2]);
          this.mark_line(line, row, idxs[3]);
        }
      });

      this.linting = false;
    }
  }

  /**
   * mark the line of the cell
   * @param {number} line    [description]
   * @param {string} message [description]
   */
  mark_line(line:number, row:number, message:string) {
    let loc = this.lookup[line];

    if (!loc) {
      console.log(`loc is undefined. line: ${line} lookup: ${JSON.stringify(this.lookup)}`);
      return;
    }

    let cell = this.cell_text[loc.cell];
    let line_text = cell.split('\n')[loc.line];

    console.log(`error ${message} in ${line_text}`);
    // const start = editor.getOffsetAt(selection.start);
    // const end = editor.getOffsetAt(selection.end);


    // TODO: figure out how to mark a single line
    
    console.log(this.notebook);
    (<any>window).notebook = this.notebook;
    (<any>window).cell = this.notebook.widgets[loc.cell];
    (<any>window).CodeMirror = CodeMirror
  }

}


/**
 * Activate extension
 */
function activate(app: JupyterLab, 
                  tracker: INotebookTracker, 
                  palette: ICommandPalette, 
                  mainMenu: IMainMenu) {
  console.log('jupyterlab-flake8 activated');
  const pl = new Linter(app, tracker, palette, mainMenu);
  console.log('linter load', pl)
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
