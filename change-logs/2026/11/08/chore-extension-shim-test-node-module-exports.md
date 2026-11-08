The extension shared-module shim test no longer fails on Node 23 and later, where every CommonJS namespace gains a "module.exports" key that a shim cannot re-export.
