import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';

/**
 * Initialization data for the jupyterlab-flake8 extension.
 */
const extension: JupyterFrontEndPlugin<void> = {
  id: 'jupyterlab-flake8',
  autoStart: true,
  activate: (app: JupyterFrontEnd) => {
    console.log('JupyterLab extension jupyterlab-flake8 is activated!');
  }
};

export default extension;
