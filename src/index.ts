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
  loaded: boolean = false;          // if pylint is available
  toggled: boolean = true;          // turn on.off linter

  linting: boolean = false;          // flag if the linter is processing

  // cache
  nbtext: string = '';                // current nb text

  constructor(app: JupyterLab, tracker: INotebookTracker, palette: ICommandPalette, mainMenu: IMainMenu){
   
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
   * Load terminal session and pylint
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
   * Check to see if pylint is available on the machine
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

      // if message includes pylint, then `which pylint` was successful and we can say the library is loaded
      if (message.includes('flake8')) {
        self.loaded = true;
        self.activate_flake8();
        console.log('flake8 loaded');
      } else {
        alert('Flake8 was not found on the machine. \n\nInstall with `pip install flake8` or `conda install flake8`')
        self.loaded = false;
      }

      // remove this listener from the terminal session
      self.term.session.messageReceived.disconnect(onTerminalMessage)
    }

    // listen for stdout in onTerminalMessage and ask `which pylint`
    this.term.session.messageReceived.connect(onTerminalMessage);
    this.term.session.send({type: 'stdin', content: ['which flake8\r']})
  }

  /**
   * Activate pylint terminal reader
   */
  activate_flake8() {
    // listen for stdout in onLintMessage
    this.term.session.messageReceived.connect(this.onLintMessage);
  }

  /**
   * Dispose of the terminal used to lint
   */
  dispose_linter() {
    if (this.term) {
      this.term.session.messageReceived.disconnect(this.onLintMessage); 
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
   * Generate lint command
   * 
   * @param  {string} contents [description]
   * @return {string} [description]
   */
  lint_cmd(contents:string): string {
    return `"${contents}" | flake8`
  }


  /**
   * [lint description]
   */
  lint() {
    console.log('linting');

    // load notebook
    let notebook = this.tracker.currentWidget.notebook;
    let pytext_array =  notebook.widgets
      .filter(cell => {
        return cell.model.type === 'code'
      })
      .map(cell => {
        if (cell.model.type === 'code') {
          return cell.model.value.text;
        } else {
          return undefined
        }
      });

    let pytext = pytext_array.join('\n\n');
    if (pytext !== this.nbtext) {
      this.nbtext = pytext;
    }
    console.log(this.nbtext);

    let lint_cmd = this.lint_cmd(this.nbtext);
    this.term.session.send({type: 'stdin', content: [`${lint_cmd}\r`]})
  }

  /**
   * Handle terminal message during linting
   * // need to figure out how to import ISession and IMessage
   * @param {any} sender [description]
   * @param {any} msg    [description]
   */
  onLintMessage(sender:any, msg:any): void {
    let message:string = msg.content[0];
    console.log(message);
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
}


/**
 * Activate extension
 */
function activate(app: JupyterLab, tracker: INotebookTracker, palette: ICommandPalette, mainMenu: IMainMenu) {
  console.log('jupyterlab-pylint activated');
  const pl = new Linter(app, tracker, palette, mainMenu);
  console.log('linter load', pl)
};


/**
 * Initialization data for the jupyterlab-pylint extension.
 */
const extension: JupyterLabPlugin<void> = {
  id: 'jupyterlab-pylint',
  autoStart: true,
  activate: activate,
  requires: [INotebookTracker, ICommandPalette, IMainMenu]
};

export default extension;
