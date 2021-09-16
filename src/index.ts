import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';

import { ICommandPalette } from '@jupyterlab/apputils';
import { IMainMenu } from '@jupyterlab/mainmenu';
import { INotebookTracker } from '@jupyterlab/notebook';
import { IEditorTracker } from '@jupyterlab/fileeditor';
import { IStateDB } from '@jupyterlab/statedb';
import { ISettingRegistry } from '@jupyterlab/settingregistry';
import { Terminal } from '@jupyterlab/terminal';
import { Cell } from '@jupyterlab/cells';
import { CodeMirrorEditor } from '@jupyterlab/codemirror';

import * as CodeMirror from 'codemirror';

// CSS
import '../style/index.css';

// extension id
const id = `jupyterlab-flake8`;

class Preferences {
  toggled: Boolean = true; // turn on/off linter
  logging: Boolean = false; // turn on/off logging
  highlight_color: string = "var(--jp-warn-color3)"; // color of highlights
  gutter_color: string = "var(--jp-error-color0)"; // color of gutter icons
  term_timeout: number = 5000; // seconds before the temrinal times out if it has not received a message
  conda_env: string = "base"; // conda environment
  terminal_name: string = "flake8term"; // persistent terminal to share between session
  configuration_file: string = ""; // global flake8 configuration file
}
/**
 * Linter
 */
class Linter {
  app: JupyterFrontEnd;
  notebookTracker: INotebookTracker;
  editorTracker: IEditorTracker;
  palette: ICommandPalette;
  mainMenu: IMainMenu;
  state: IStateDB;
  term: Terminal;

  prefsKey = `${id}:preferences`;
  settingsKey = `${id}:plugin`;

  // Default Options
  prefs = new Preferences();

  // flags
  loaded: boolean = false; // flag if flake8 is available
  linting: boolean = false; // flag if the linter is processing
  termTimeoutHandle: number; // flag if the linter is processing

  // notebook
  cell_text: Array<string>; // current nb cells
  cells: Array<any>; // widgets from notebook
  notebook: any; // current nb cells
  lookup: any; // lookup of line index

  // editor
  editor: any; // current file editor widget
  editortext: any; // current file editor text
  gutter_id: string = 'CodeMirror-lintgutter'; // gutter element id

  // cache
  marks: Array<CodeMirror.TextMarker> = []; // text marker objects currently active
  bookmarks: Array<any> = []; // text marker objects in editor // --- Temporary fix since gutter doesn't work in editor
  docs: Array<any> = []; // text marker objects currently active
  text: string = ''; // current nb text
  process_mark: Function; // default line marker processor
  os: string = ''; // operating system
  settingRegistry: ISettingRegistry; // settings

  constructor(
    app: JupyterFrontEnd,
    notebookTracker: INotebookTracker,
    editorTracker: IEditorTracker,
    palette: ICommandPalette,
    mainMenu: IMainMenu,
    state: IStateDB,
    settingRegistry: ISettingRegistry
  ) {
    this.app = app;
    this.mainMenu = mainMenu;
    this.notebookTracker = notebookTracker;
    this.editorTracker = editorTracker;
    this.palette = palette;
    this.state = state;
    this.settingRegistry = settingRegistry;

    // load settings from the registry
    Promise.all([
      this.settingRegistry.load(this.settingsKey),
      app.restored,
    ]).then(([settings]) => {
      this.update_settings(settings, true);

      // callback to update settings on changes
      settings.changed.connect((settings: ISettingRegistry.ISettings) => {
        this.update_settings(settings);
      });

      // on first load, if linter enabled, start it up
      if (this.prefs.toggled) {
        this.load_linter();
      }
    });

    // activate function when cell changes
    this.notebookTracker.currentChanged.connect(
      this.onActiveNotebookChanged,
      this
    );

    // activate when editor changes
    this.editorTracker.currentChanged.connect(this.onActiveEditorChanged, this);

    // add menu item
    this.add_commands();
  }

  /**
   * Update settings callback
   * @param {ISettingRegistry.ISettings} settings
   */
  private update_settings(
    settings: ISettingRegistry.ISettings,
    first_load: Boolean = false
  ) {
    let old = JSON.parse(JSON.stringify(this.prefs)); // copy old prefs

    // set settings to prefs object
    Object.keys(settings.composite).forEach((key: string) => {
      (<any>this.prefs)[key] = (<any>settings.composite)[key];
    });
    this.log(`loaded settings ${JSON.stringify(this.prefs)}`);

    // toggle linter
    if (!first_load && old.toggled !== this.prefs.toggled) {
      this.toggle_linter();
    }
  }

  /**
   * Load terminal session and flake8
   */
  private async load_linter() {
    // Bail if there are no terminals available.
    if (!this.app.serviceManager.terminals.isAvailable()) {
      this.log(
        'Disabling jupyterlab-flake8 plugin because it cant access terminal'
      );
      this.loaded = false;
      this.prefs.toggled = false;
      return;
    }

    // try to connect to previous terminal, if not start a new one
    // TODO: still can't set the name of a terminal, so for now saving the "new"
    // terminal name in the settings (#16)
    let session;
    try {
      session = await this.app.serviceManager.terminals
        .connectTo({ model: {name: this.prefs.terminal_name }})
    } catch(e) {
      this.log(`starting new terminal session`);
      session = await this.app.serviceManager.terminals.startNew();
    };

    // save terminal name
    this.setPreference('terminal_name', session.name);

    // start a new terminal session
    this.log(`set terminal_name to ${session.name}`);
    this.term = new Terminal(session);

    // flush on load
    function _flush_on_load(sender: any, msg: any) {
      return;
    }

    // this gets rid of any messages that might get sent on load
    // may fix #28 or #31
    this.term.session.messageReceived.connect(_flush_on_load, this);

    // get OS
    const _this: Linter = this; 
    function _get_OS(sender: any, msg: any) {
      if (msg.content) {
        let message: string = msg.content[0] as string;

        // throw away non-strings
        if (typeof message !== 'string') {
          return;
        }

        if (message.indexOf('command not found') > -1) {
          _this.log(`python command failed on this machine`);
          _this.term.session.messageReceived.disconnect(_get_OS, _this);
          _this.finish_load();
        }

        // set OS
        if (message.indexOf('posix') > -1) {
          _this.os = 'posix';
        } else if (
          message.indexOf('nt(') === -1 &&
          message.indexOf('int') === -1 &&
          message.indexOf('nt') > -1
        ) {
          _this.os = 'nt';
        } else {
          return;
        }
        _this.log(`os: ${_this.os}`);

        // disconnect the os listener and connect empty listener
        _this.term.session.messageReceived.disconnect(_get_OS, _this);

        // setup stage
        _this.setup_terminal();
      }
    }

    // wait a moment for terminal to load and then ask for OS
    setTimeout(() => {

      // disconnect flush
      this.term.session.messageReceived.disconnect(_flush_on_load, this);

      // ask for the OS
      this.term.session.messageReceived.connect(_get_OS, this);
      this.term.session.send({
        type: 'stdin',
        content: [`python -c "import os; print(os.name)"\r`],
      });

    }, 1500);
  }

  private setup_terminal() {
    if (this.os === 'posix') {
      this.term.session.send({ type: 'stdin', content: [`HISTFILE= ;\r`] });
    }

    // custom conda-env
    if (this.prefs.conda_env !== 'base') {
      this.set_env();
    } else {
      this.finish_load();
    }
  }

  // activate specific conda environment
  private set_env() {
    this.log(`conda env: ${this.prefs.conda_env}`);
    if (this.os === 'posix') {
      this.term.session.send({
        type: 'stdin',
        content: [`conda activate ${this.prefs.conda_env}\r`],
      });
    } else if (this.os !== 'posix') {
      this.term.session.send({
        type: 'stdin',
        content: [`source activate ${this.prefs.conda_env}\r`],
      });
    }

    this.finish_load();
  }

  private finish_load() {
    try {
      // wait a moment for terminal to get initial commands out of its system
      setTimeout(() => {
        this.loaded = true;
        this.activate_flake8();
      }, 500);
    } catch (e) {
      this.loaded = false;
      this.prefs.toggled = false;
      this.term.dispose();
    }
  }

  /**
   * Activate flake8 terminal reader
   */
  private activate_flake8() {
    // listen for stdout in onLintMessage
    this.term.session.messageReceived.connect(this.onLintMessage, this);
  }

  /**
   * Dispose of the terminal used to lint
   */
  private dispose_linter() {
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
    this.checkNotebookGutters();

    // run on cell changing
    this.notebookTracker.activeCellChanged.disconnect(
      this.onActiveCellChanged,
      this
    );
    this.notebookTracker.activeCellChanged.connect(
      this.onActiveCellChanged,
      this
    );

    // run on stateChanged
    this.notebook.model.stateChanged.disconnect(this.onActiveCellChanged, this);
    this.notebook.model.stateChanged.connect(this.onActiveCellChanged, this);
  }

  /**
   * Run linter when active cell changes
   */
  private onActiveCellChanged(): void {
    this.checkNotebookGutters();
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
    this.checkEditorGutters();

    // run on stateChanged
    this.editor.model.stateChanged.disconnect(this.onActiveEditorChanges, this);
    this.editor.model.stateChanged.connect(this.onActiveEditorChanges, this);
  }

  /**
   * Run linter on active editor changes
   */
  private onActiveEditorChanges(): void {
    this.checkEditorGutters();
    if (this.loaded && this.prefs.toggled) {
      if (!this.linting) {
        this.lint_editor();
      } else {
        this.log('flake8 is already running onEditorChanged');
      }
    }
  }

  private checkNotebookGutters(): void {
    this.notebook.widgets.forEach((widget: any) => {
      const editor = widget.inputArea.editor;
      const lineNumbers = editor._config.lineNumbers;
      const codeFolding = editor._config.codeFolding;
      const gutters = [
        lineNumbers && 'CodeMirror-linenumbers',
        codeFolding && 'CodeMirror-foldgutter',
        this.gutter_id,
      ].filter((d) => d);
      editor.editor.setOption('gutters', gutters);
    });
  }

  private checkEditorGutters(): void {
    // let editor = this.editorTracker.currentWidget.content;
    // let editorWidget = this.editorTracker.currentWidget;

    const editor = this.editor.editor;
    const lineNumbers = editor._config.lineNumbers;
    const codeFolding = editor._config.codeFolding;
    const gutters = [
      lineNumbers && 'CodeMirror-linenumbers',
      codeFolding && 'CodeMirror-foldgutter',
      this.gutter_id,
    ].filter((d) => d);
    editor.setOption('gutters', gutters);
  }

  /**
   * Generate lint command
   *
   * @param  {string} contents - contents of the notebook ready to be linted
   * @return {string} [description]
   */
  private lint_cmd(contents: string): string {
    // escaped characters common to powershell and unix
    let escaped = contents.replace(/[`\\]/g, '\\$&');

    // escaped characters speciic to shell
    if (this.os === 'nt') {
      escaped = contents.replace(/["]/g, '`$&'); // powershell
    } else {
      escaped = contents.replace(/["]/g, '\\$&'); // unix
    }

    escaped = escaped.replace('\r', ''); // replace carriage returns

    // ignore magics by commenting
    escaped = escaped
      .split('\n')

      // handle ipy magics %% and %
      .map((line: string) => {
        if (line.startsWith('%%')) {
          return `# ${line}`;
        } else {
          return line;
        }
      })
      .map((line: string) => {
        if (line.startsWith('%')) {
          return `# ${line}`;
        } else {
          return line;
        }
      })
      .join(this.newline());

    // remove final \n (#20)
    if (escaped.endsWith(this.newline())) {
      if (this.os === 'nt') {
        escaped = escaped.slice(0, -2); // powershell
      } else {
        escaped = escaped.slice(0, -1); // unix
      }
    }

    let config_option = '';

    if (
      this.prefs.configuration_file !== null &&
      this.prefs.configuration_file !== ''
    ) {
      config_option = `--config="${this.prefs.configuration_file}"`;
    }

    if (this.os === 'nt') {
      // powershell
      return `echo "${escaped}" | flake8 ${config_option} --exit-zero - ; if($?) {echo "@jupyterlab-flake8 finished linting"} ; if (-not $?) {echo "@jupyterlab-flake8 finished linting failed"} `;
    } else {
      // unix
      return `(echo "${escaped}" | flake8 ${config_option} --exit-zero - && echo "@jupyterlab-flake8 finished linting" ) || (echo "@jupyterlab-flake8 finished linting failed")`;
    }
  }

  /**
   * Determine new line character based on platform
   */
  private newline() {
    // powershell by default on windows
    if (this.os === 'nt') {
      return '`n';

      // otherwise unix
    } else {
      return '\n';
    }
  }

  /**
   * Determine if text is input
   * @param {string} text [description]
   */
  private text_exists(text: string) {
    return text;
    // return text && text !== '\n' && text !== '\n\n';
  }

  /**
   * Clear all current marks from code mirror
   */
  private clear_marks() {
    // clear marks
    this.marks.forEach((mark: CodeMirror.TextMarker) => {
      mark.clear();
    });
    this.marks = [];

    // --- Temporary fix since gutter doesn't work in editor
    // clear error messages in editor
    this.clear_error_messages();

    // clear gutter
    this.docs.forEach((doc: any) => {
      doc.cm.clearGutter(this.gutter_id);
    });
    this.docs = [];
  }

  /**
   * Lint the CodeMirror Editor
   */
  private lint_editor() {
    this.linting = true; // no way to turn this off yet
    this.process_mark = this.mark_editor;

    // catch if file is not a .py file
    if (
      this.editor.context.path.indexOf('.py') > -1 ||
      this.editor.model._defaultLang === 'python'
    ) {
      this.log('getting editor text from python file');
    } else {
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
  private mark_editor(line: number, ch: number) {
    this.log(`marking editor`);

    line = line - 1; // 0 index
    ch = ch - 1; // not sure

    // get lines
    let from = { line: line, ch: ch };
    let to = { line: line, ch: ch + 1 };

    // get code mirror editor
    let doc = this.editor.editorWidget.editor.doc;

    return [doc, from, to, 'editor'];
  }

  /**
   * Run flake8 linting on notebook cells
   */
  private lint_notebook() {
    this.linting = true; // no way to turn this off yet
    this.process_mark = this.mark_notebook;

    // load notebook
    this.cells = this.notebook.widgets;

    this.log('getting notebook text');

    // return text from each cell if its a code cell
    this.cell_text = this.cells.map(
      (cell: any, cell_idx: number, cell_arr: any[]) => {
        if (
          cell.model.type === 'code' &&
          this.text_exists(cell.model.value.text)
        ) {
          // append \n\n if its not the last cell
          if (cell_idx !== cell_arr.length - 1) {
            return `${cell.model.value.text}\n\n`;
          } else {
            return cell.model.value.text;
          }
        } else {
          return '';
        }
      }
    );

    // create dictionary of lines
    this.lookup = {};
    let line = 1;
    this.cell_text.map((cell: any, cell_idx: number, cell_arr: any[]) => {
      // if there is text in the cell,
      if (this.text_exists(cell)) {
        let lines = cell.split('\n');
        for (let idx = 0; idx < lines.length - 1; idx++) {
          this.lookup[line] = {
            cell: cell_idx,
            line: idx,
          };
          line += 1;
        }
      }

      // if its the last cell in the notebook and its empty
      else if (cell_idx === cell_arr.length - 1) {
        this.lookup[line] = {
          cell: cell_idx,
          line: 0,
        };
      }
    });

    // ignore other languages (#32)
    // this seems to be all %%magic commands except %%capture
    this.cell_text = this.cell_text.map((cell: any, cell_idx: number, cell_arr: any[]) => {
      let firstline = cell.split('\n')[0];
      if (firstline && firstline.startsWith("%%") && !(firstline.indexOf("%%capture") > -1)) {
        return cell.split('\n').map((t:string) => t != "" ? `# ${t}` : "").join('\n');
      } else {

        return cell;
      }
    });

    // join cells with text with two new lines
    let pytext = this.cell_text.join('');

    // run linter
    this.lint(pytext);
  }

  /**
   * mark the line of the cell
   * @param {number} line    the line # returned by flake8
   * @param {number} ch      the character # returned by flake 8
   */
  private mark_notebook(line: number, ch: number) {
    let loc = this.lookup[line];
    ch = ch - 1; // make character 0 indexed

    if (!loc) {
      return;
    }

    let from = { line: loc.line, ch: ch };
    let to = { line: loc.line, ch: ch + 1 };

    // get cell instance
    let cell: Cell = this.notebook.widgets[loc.cell];

    // get cell's code mirror editor
    let editor: CodeMirrorEditor = cell.inputArea.editorWidget
      .editor as CodeMirrorEditor;
    let doc = editor.doc;

    return [doc, from, to, 'notebook'];
  }

  /**
   * Lint a python text message and callback marking function with line and character
   * @param {string}   pytext        [description]
   */
  private lint(pytext: string) {
    // cache pytext on text
    if (pytext !== this.text) {
      this.text = pytext;
    } else {
      // text has not changed
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
    this.term.session.send({ type: 'stdin', content: [`${lint_cmd}\r`] });
    this.termTimeoutHandle = setTimeout(() => {
      if ((this.linting = true)) {
        this.log('lint command timed out');
        alert(
          'jupyterlab-flake8 ran into an issue connecting with the terminal. Please try reloading the browser or re-installing the jupyterlab-flake8 extension.'
        );
        this.lint_cleanup();
        this.dispose_linter();
        this.prefs.toggled = false;
      }
    }, this.prefs.term_timeout);
  }

  /**
   * Handle terminal message during linting
   * TODO: import ISession and IMessage types for sender and msg
   * @param {any} sender [description]
   * @param {any} msg    [description]
   */
  private onLintMessage(sender: any, msg: any): void {
    clearTimeout(this.termTimeoutHandle);
    if (msg.content) {
      let message: string = msg.content[0] as string;

      // catch non-strings
      if (typeof message !== 'string') {
        return;
      }

      // log message
      this.log(`terminal message: ${message}`);

      // if message a is a reflection of the command, return
      if (message.indexOf('Traceback') > -1) {
        alert(
          `Flake8 encountered a python error. Make sure flake8 is installed and on the system path. \n\nTraceback: ${message}`
        );
        this.lint_cleanup();
        return;
      }

      // if message a is a reflection of the command, return
      if (message.indexOf('command not found') > -1) {
        alert(
          `Flake8 was not found in this python environment. \n\nIf you are using a conda environment, set the 'conda_env' setting in the Advanced Settings menu and reload the Jupyter Lab window.\n\nIf you are not using a conda environment, Install Flake8 with 'pip install flake8' or 'conda install flake8' and reload the Jupyter Lab window`
        );
        this.lint_cleanup();
        return;
      }

      message.split(/(?:\n|\[)/).forEach((m) => {
        if (m.includes('stdin:')) {
          let idxs = m.split(':');
          let line = parseInt(idxs[1]);
          let ch = parseInt(idxs[2]);
          this.log(idxs[3]);

          this.get_mark(line, ch, idxs[3].slice(0, -1));
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
  private get_mark(line: number, ch: number, message: string) {
    let doc, from, to, context;
    try {
      if (this.process_mark && typeof this.process_mark === 'function') {
        [doc, from, to, context] = this.process_mark(line, ch);
      }
    } catch (e) {
      this.log(`failed to run process_mark`);
      return;
    }

    if (!doc || !from || !to) {
      this.log(`mark location not fully defined`);
      return;
    }

    this.mark_line(doc, from, to, message, context);
  }

  /**
   * Mark line in document
   * @param {any}    doc     [description]
   * @param {any}    from    [description]
   * @param {any}    to      [description]
   * @param {string} message [description]
   */
  private mark_line(
    doc: any,
    from: any,
    to: any,
    message: string,
    context: 'editor' | 'notebook'
  ) {
    let gutter_color = this.prefs.gutter_color;

    // gutter marker - this doesn't work in the editor
    function makeMarker() {
      let marker = document.createElement('div');
      marker.innerHTML = `<div class='jupyterlab-flake8-lint-gutter-container' style='color: ${gutter_color}''>
        <div>◉</div><div class='jupyterlab-flake8-lint-gutter-message'>${message}</div>
      </div>`;
      return marker;
    }

    // store gutter marks for later
    doc.cm.setGutterMarker(from.line, this.gutter_id, makeMarker());

    this.docs.push(doc);

    // --- Temporary fix since gutters don't show up in editor
    // show error message in editor
    if (context === 'editor') {
      let lint_alert = document.createElement('span');
      let lint_message = document.createTextNode(`------ ${message}`);
      lint_alert.appendChild(lint_message);
      lint_alert.className = 'jupyterlab-flake8-lint-message-inline';

      // add error alert node to the 'to' location
      this.bookmarks.push((<any>doc).addLineWidget(from.line, lint_alert));
    }

    // mark the text position with highlight
    this.marks.push(
      doc.markText(from, to, {
        // replacedWith: selected_char_node,
        className: 'jupyterlab-flake8-lint-message',
        css: `
          background-color: ${this.prefs.highlight_color}
        `,
      })
    );
  }

  /**
   * // --- Temporary fix since gutters don't show up in editor
   * Clear all error messages
   */
  private clear_error_messages() {
    this.bookmarks.forEach((bookmark: any) => {
      bookmark.clear();
    });
  }

  /**
   * Tear down lint fixtures
   */
  private lint_cleanup() {
    this.linting = false;
    // this.process_mark = undefined;
  }

  /**
   * Show browser logs
   * @param {any} msg [description]
   */
  private log(msg: any) {
    // return if prefs.logging is not enabled
    if (!this.prefs.logging) {
      return;
    }

    // convert object messages to strings
    if (typeof msg === 'object') {
      msg = JSON.stringify(msg);
    }

    // prepend name
    let output = `jupyterlab-flake8: ${msg}`;
    console.log(output);
  }

  /**
   * Create menu / command items
   */
  add_commands() {
    let category = 'Flake8';

    // define all commands
    let commands: any = {
      'flake8:toggle': {
        label: 'Enable Flake8',
        isEnabled: () => {
          return this.loaded;
        },
        isToggled: () => {
          return this.prefs.toggled;
        },
        execute: async () => {
          this.setPreference('toggled', !this.prefs.toggled);
        },
      },
      'flake8:show_browser_logs': {
        label: 'Output Flake8 Browser Console Logs',
        isEnabled: () => {
          return this.loaded;
        },
        isToggled: () => {
          return this.prefs.logging;
        },
        execute: () => {
          this.setPreference('logging', !this.prefs.logging);
        },
      },
    };

    // add commands to menus and palette
    for (let key in commands) {
      this.app.commands.addCommand(key, commands[key]);
      this.palette.addItem({ command: key, category: category });
    }

    // add to view Menu
    this.mainMenu.viewMenu.addGroup(
      Object.keys(commands).map((key) => {
        return { command: key };
      }),
      30
    );
  }

  /**
   * Turn linting on/off
   */
  private toggle_linter() {
    if (this.prefs.toggled) {
      this.load_linter();
    } else {
      this.dispose_linter();
    }
  }

  /**
   * Save state preferences
   */
  private async setPreference(key: string, val: any) {
    await Promise.all([
      this.settingRegistry.load(this.settingsKey),
      this.app.restored,
    ]).then(([settings]) => {
      settings.set(key, val); // will automatically call update
    });
  }
}

/**
 * Activate extension
 */
function activate(
  app: JupyterFrontEnd,
  notebookTracker: INotebookTracker,
  editorTracker: IEditorTracker,
  palette: ICommandPalette,
  mainMenu: IMainMenu,
  state: IStateDB,
  settingRegistry: ISettingRegistry
) {
  new Linter(
    app,
    notebookTracker,
    editorTracker,
    palette,
    mainMenu,
    state,
    settingRegistry
  );
}

  // activate: (app: JupyterFrontEnd, settingRegistry: ISettingRegistry | null) => {
  //   console.log('JupyterLab extension jupyterlab-flake8 is activated!');

  //   if (settingRegistry) {
  //     settingRegistry
  //       .load(plugin.id)
  //       .then(settings => {
  //         console.log('jupyterlab-flake8 settings loaded:', settings.composite);
  //       })
  //       .catch(reason => {
  //         console.error('Failed to load settings for jupyterlab-flake8.', reason);
  //       });
  //   }
  // }


/**
 * Initialization data for the jupyterlab-flake8 extension.
 */
const plugin: JupyterFrontEndPlugin<void> = {
  id: 'jupyterlab-flake8',
  autoStart: true,
  activate: activate,
  requires: [
    INotebookTracker,
    IEditorTracker,
    ICommandPalette,
    IMainMenu,
    IStateDB,
    ISettingRegistry
  ],
};

export default plugin;

