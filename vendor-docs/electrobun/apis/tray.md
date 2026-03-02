# Tray

## Overview

Create and manage system tray icon and menu.

## Basic Usage

```typescript
import { Tray } from "electrobun/bun";

const tray = new Tray({
  title: "Example Tray Item (click to create menu)",
  // This can be a views url or an absolute file path
  image: "views://assets/electrobun-logo-32-template.png",
  template: true,
  width: 32,
  height: 32,
});
```

## Constructor Options

### title

The text that appears in the system tray.

### image

Optional URL to an image file. Use the `views://` schema for locally bundled images.

### template

Allows template images on macOS. Template images use opacity to create adaptive black and white images for light/dark mode compatibility. Full-color images display as-is without this setting.

### width and height

Define the dimensions of the tray image.

## Methods

### setMenu()

Displays the tray menu. Typically called in response to `tray-clicked` events. Common pattern involves dynamically generating menus from application state to implement features like checkbox toggles.

### Menu Items

Refer to the [Application Menu](./application-menu.md) documentation for available menu item properties.

## Events

### tray-clicked

Triggered when the system tray item is clicked.

### tray-item-clicked

Triggered when a system tray menu item or submenu item is selected.
