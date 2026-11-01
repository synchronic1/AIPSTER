"""AIPSTER worker packaging tools (tray app, installers, launchers).

Regular package with a merged path: without this file the directory is a
bare namespace portion and loses to an installed PyPI ``packaging`` regular
package, so ``packaging.aipster_tray`` stops importing in developer venvs
(pytest pulls PyPI ``packaging`` in). The merge keeps both
``packaging.aipster_tray`` and e.g. ``packaging.version`` importable.
"""

from pkgutil import extend_path

__path__ = extend_path(__path__, __name__)
