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
class PyLinter {
  app: JupyterLab;
  tracker: INotebookTracker;
  palette: ICommandPalette;
  mainMenu: IMainMenu;
  term: Terminal;

  // Default Options
  loaded: boolean = false;      // if pylint is available
  toggled: boolean = true;      // turn on.off linter
  pylintrc: string = '.pylintrc';    // name of pylintrc file

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
      console.log('Disabling pylinter plugin because it cant access terminal');
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
        this.check_pylint();
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
  check_pylint() {
    let self = this;

    // need to figure out how to import ISession and IMessage
    function onTerminalMessage(sender:any, msg:any): void {
      let message:string = msg.content[0];
      console.log(message);

      // return if its just a message reflection
      if (message.includes('which pylint')) {
        return;
      }

      // if message includes pylint, then `which pylint` was successful and we can say the library is loaded
      if (message.includes('pylint')) {
        self.loaded = true;
        self.activate_pylint();
      } else {
        alert('Pylint was not found on the machine. Install with `pip install pylint` or `conda install pylint`')
        self.loaded = false;
      }

      // remove this listener from the terminal session
      self.term.session.messageReceived.disconnect(onTerminalMessage)
    }

    // listen for stdout in onTerminalMessage and ask `which pylint`
    this.term.session.messageReceived.connect(onTerminalMessage);
    this.term.session.send({type: 'stdin', content: ['which pylint\r']})
  }

  /**
   * Activate pylint terminal reader
   */
  activate_pylint() {
    // listen for stdout in onLintMessage
    this.term.session.messageReceived.connect(this.onLintMessage);
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
    let category = 'Pylint';

    // define all commands
    let commands:any = {
      'pylint:toggle': {
        label: "Toggle pylint",
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
    
    // only run when on a code cell
    let active_cell = this.tracker.activeCell;
    if ( (active_cell !== null) && (active_cell.model.type === 'code') ){

      console.log('active code cell changed')
      let editor: any = active_cell.editor;
      let current_mode: string = editor.getOption('mode');
      
      if (this.toggled) {
        // this.term.session.send({type: 'stdin', content: ['which pylint\r']})

        editor.setOption("mode", this.define_mode(current_mode));
      } else {
        // not sure what this does yet
        // let original_mode = (current_mode.match(/^spellcheck_/)) ? current_mode.substr(11) : current_mode
        // editor.setOption("mode", original_mode);
      }
    }
  }
  //         'pylint@python',
//         '--msg-template=\'{line}:{column}:{msg_id}: {msg} ({symbol})\'',
//         '--module-rgx=.*',  # don't check the module name
//         '--reports=n',      # remove tables
// '--persistent=n', # don't save the old score (no sense for temp)
// 

  define_mode = (original_mode_spec: string) => {
    console.log(original_mode_spec)
      // if (original_mode_spec.indexOf("spellcheck_") == 0){
      //     return original_mode_spec;
      // }
      // var me = this;
      // var new_mode_spec = 'spellcheck_' + original_mode_spec;
      // CodeMirror.defineMode(new_mode_spec, (config:any) => {
      //     var spellchecker_overlay = {
      //         name: new_mode_spec,
      //         token: function (stream:any, state:any) {
      //             if (stream.eatWhile(me.rx_word_char)){
      //         var word = stream.current().replace(/(^')|('$)/g, '');
      //         if (!word.match(/^\d+$/) && (me.dictionary !== undefined) && !me.dictionary.check(word)) {
      //             return 'spell-error';
      //                 }
      //             }
                  
      //             stream.eatWhile(me.rx_non_word_char);
      //             return null;
      //         }
      //     };
      //     return CodeMirror.overlayMode(
      //         CodeMirror.getMode(config, original_mode_spec), spellchecker_overlay, true);
      // });
      // return new_mode_spec;
  }
}


/**
 * Activate extension
 */
function activate(app: JupyterLab, tracker: INotebookTracker, palette: ICommandPalette, mainMenu: IMainMenu) {
  console.log('jupyterlab-pylint activated');
  const pl = new PyLinter(app, tracker, palette, mainMenu);
  console.log('pylinter Loaded', pl);
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
