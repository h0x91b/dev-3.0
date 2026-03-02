# BrowserView API

## Overview

The BrowserView API enables creation and control of browser views (webviews) in Electrobun applications. Rather than creating BrowserViews directly from the bun process, the recommended approach is using the BrowserWindow class, which automatically generates a default BrowserView filling the window, or implementing Webview Tags within HTML for nested BrowserViews from the browser context.

## Access Patterns

Three primary methods exist for accessing webviews:

1. Retrieve webviews created by BrowserWindow or WebviewTag using `BrowserView.getById(id)`
2. Access the default webview via `win.webview` on a BrowserWindow instance
3. Create BrowserViews directly (advanced use cases only)

Direct creation requires the webview to be added to a window for rendering to occur.

## Constructor Options

### frame

Establishes webview dimensions relative to its parent window. The default webview created through BrowserWindow automatically stretches to cover window dimensions.

### url

Specifies the initial navigation URL when the webview opens. Supports both internet URLs and the `views://` scheme for bundled local content.

### html

Sets an HTML string for initial webview content, supporting embedded JavaScript and CSS. Use instead of the `url` property.

### partition

Separates browser sessions (cookies, authentication state, etc.). Prefix with `persist:` for persistence across application restarts.

### preload

Designates a script executing after HTML parsing but before other JavaScript. Supports remote URLs, bundled content via `views://`, or inline JavaScript.

### rpc

Establishes remote procedure call capabilities between the bun process and webview, enabling asynchronous function execution across contexts. Requires defining typed RPC schemas for type safety.

### sandbox

When enabled, activates sandbox mode for untrusted content, disabling RPC while permitting event emission.

## Static Methods

### BrowserView.getAll()

Returns all BrowserView references, including those created via BrowserWindow, WebviewTags, and manual instantiation.

### BrowserView.getById(id)

Retrieves a specific BrowserView by its identifier.

### BrowserView.defineRPC()

Creates RPC instances for establishing typed communication between bun and webview contexts.

## Instance Methods

### executeJavascript(script)

Executes arbitrary JavaScript within the webview at any time, distinct from preload scripts.

### loadURL(url)

Navigates the webview to a specified URL, triggering navigation events.

### loadHTML(options)

Replaces webview content with provided HTML, triggering navigation events.

### setNavigationRules(rules)

Implements allow/block URL patterns controlling navigation permissions. Rules use glob-style wildcards with `*` matching any characters. Block rules are prefixed with `^`. Evaluation occurs synchronously in native code without bun process callbacks.

### findInPage(text, options)

Searches webview content, highlighting matches and scrolling to results. Supports direction and case sensitivity options.

### stopFindInPage()

Clears find-in-page highlighting and results.

### openDevTools()

Opens the DevTools window for the webview.

### closeDevTools()

Closes or hides the DevTools window.

### toggleDevTools()

Toggles DevTools visibility.

### on(name, handler)

Subscribes to BrowserView events.

## Properties

### id

The webview's unique identifier.

### hostWebviewId

Available only for BrowserViews created as nested OOPIFs via WebviewTag, containing the parent BrowserView's ID.

### rpc

Provides access to generated typed RPC request and message methods after RPC configuration. Includes the built-in `rpc.request.evaluateJavascriptWithResponse()` method for executing JavaScript and retrieving results.

## Events

### will-navigate

Fires when navigation is about to occur, providing the target URL and navigation rule allowance status.

### did-navigate

Fires after webview navigation completes.

### did-navigate-in-page

Fires following in-page navigation.

### did-commit-navigation

Fires when the webview begins receiving content for the main frame post-navigation.

### dom-ready

Fires from the browser context when the DOM is ready.

### new-window-open

Fires when the browser attempts opening a new window (popup or right-click "open in new window"). Event detail provides the target URL and modifier key information.

### download-started

Fires when file downloads begin, providing filename and save path.

### download-progress

Fires periodically during downloads, reporting progress percentage (0-100).

### download-completed

Fires upon successful download completion with filename and save path.

### download-failed

Fires when downloads fail or are canceled, including error messages.
