"""AIPSTER worker tray controller (Windows milestone; core is portable).

Modules: firstrun (shared first-run setup), state (pure state/menu model),
child (worker process lifecycle), ipc_win32 (single-instance + commands),
controller (state machine + CLI), backend_* (presentation).
"""
