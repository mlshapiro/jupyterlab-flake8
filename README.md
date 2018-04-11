# Jupyterlab-pylint

Jupyterlab extension for integrating [pylint](https://pylint.readthedocs.io/en/latest/) 


## Prerequisites

- JupyterLab

## Installation

```bash
jupyter labextension install jupyterlab-pylint
```

## Development

For a development install (requires npm version 4 or later), do the following in the repository directory:

```bash
npm install
npm run build
jupyter labextension link .
```

To rebuild the package and the JupyterLab app:

```bash
npm run build
jupyter lab build
```

To run jupyter lab in watch mode:

```bash
jupyter lab --watch
```

## Acknowledgment

- Used https://github.com/ijmbarr/jupyterlab_spellchecker as a starting point
