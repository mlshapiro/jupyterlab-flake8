> This is still in development

# Jupyterlab-flake8

Jupyterlab extension for flake8

## Prerequisites

- JupyterLab

## Installation

```bash
jupyter labextension install jupyterlab-flake8
```

## Development

It is advisable to use a seperate conda environment for development:

```bash
$ conda create -n jlflake8 anaconda
```

For a development install (requires npm version 4 or later), do the following in the repository directory:

```bash
$ npm install
$ npm run build
$ jupyter labextension install . --no-build  
```

To rebuild the package and the JupyterLab app:

```bash
$ npm run build
$ jupyter lab build
```

To run jupyter lab and thet typescript in watch mode:

```bash
$ jupyter lab --watch       # in the first terminal window
$ npm run watch             # in a new terminal window
```


## Acknowledgment

- Used https://github.com/ijmbarr/jupyterlab_spellchecker as a starting point
