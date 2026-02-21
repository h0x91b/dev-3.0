# Bundled Assets

## Bundling Static Assets in your app

The `views://` schema in Electrobun provides a method for handling static assets, ensuring they are securely and efficiently managed within the application's bundle.

### Overview of `views://` Schema

The `views://` schema is a custom protocol used in Electrobun to reference assets and files within the application bundle. This schema allows for clean separation of application logic and resources, ensuring that static assets like HTML, CSS, and JavaScript files are encapsulated within specified views or components.

You can think of the `views://` schema as an alternative to `https://`. It can be used in BrowserViews anywhere a normal URL can be used, and Electrobun will securely map those paths to the static asset folder in your application bundle.

### Using `views://` in BrowserWindow URLs

You can use the `views://` schema to set the URL for a new `BrowserWindow()` in Electrobun:

```typescript
const { BrowserWindow } = require("electrobun");

const mainWindow = new BrowserWindow({
  width: 800,
  height: 600,
  title: "Main Window",
});

mainWindow.loadURL("views://mainview/index.html");
```

In this example, `mainWindow` loads an HTML file located at `views://mainview/index.html`. This URL points to the `index.html` file within the `mainview` directory defined in the `electrobun.config`.

### Incorporating CSS and JavaScript

Using the `views://` schema, CSS and JavaScript files can be loaded directly within an HTML file bundled in the application:

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>Sample Page</title>
    <link rel="stylesheet" href="views://mainview/style.css" />
    <script src="views://mainview/script.js"></script>
    <style>
      div {
        background: url(views://mainview/somebg.png);
      }
    </style>
  </head>
  <body>
    <h1>Welcome to Electrobun</h1>
  </body>
</html>
```

You can also use a `views://` URL directly in CSS just like you would use any `https://` URL.

### Bundling Static Assets via `electrobun.config`

The `electrobun.config` file can be configured to bundle and manage static assets. The property name for each view can be anything you choose. You can specify as many views as needed. This maps directly to the path you would use when referencing a file.

```typescript
build: {
    views: {
        mainview: {
            entrypoint: "src/mainview/index.ts",
            // All Bun.build() options are supported here
        },
    },
    copy: {
        "src/mainview/index.html": "views/mainview/index.html",
        "src/mainview/style.css": "views/mainview/style.css",
        "src/mainview/script.js": "views/mainview/script.js",
    },
}
```

> **Note:** In the "copy" section, the destination is `views/mainview/` which maps to the URL `views://mainview/`.

### Summary

The `views://` schema in Electrobun provides a structured and secure way to manage and reference static assets within your applications. By configuring the `electrobun.config` appropriately and using the schema within your application code, you can ensure a clean, organized, and encapsulated asset management system.
