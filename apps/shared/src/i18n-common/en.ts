// English source of truth for the strings the desktop app and the web dashboard
// both translate under the same key paths. Each app spreads these namespaces
// into its own `en` catalog, so a key lives here exactly once and every locale
// file under this directory translates it exactly once for both surfaces.
//
// A key belongs here only when BOTH apps use the same path AND the same
// English string; app-specific wording stays in the app's own catalog.

export const commonEn = {
  common: {
    save: 'Save',
    cancel: 'Cancel',
    close: 'Close',
    confirm: 'Confirm',
    delete: 'Delete',
    refresh: 'Refresh',
    retry: 'Retry',
    set: 'Set',
    replace: 'Replace',
    clear: 'Clear',
    off: 'Off',
    collapse: 'Collapse',
    expand: 'Expand'
  },

  cron: {
    triggerNow: 'Trigger now'
  },

  profiles: {
    cloneFromNone: 'None (blank)',
    rename: 'Rename',
    soulSaved: 'SOUL.md saved'
  },

  skills: {
    all: 'All'
  },

  language: {
    switchTo: 'Switch language'
  }
}

export type CommonTranslations = typeof commonEn
