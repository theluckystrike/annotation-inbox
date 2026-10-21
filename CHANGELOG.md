# annotation-inbox

## 1.2.0

### Minor Changes

- After a minor or major update, Annotation Inbox opens one What's new tab in the background. The tab and settings card suggest other NoteMods plugins and Zovo Chat and link to notemods.com for feedback ([privacy](https://notemods.com/privacy/)). The tab sends no data. Turn the tab off in Settings. Add the Send feedback command. The plugin makes no new network requests.

## 1.1.2

### Patch Changes

- b0b08cb: Stop sync requests, waits and new vault writes when disabled, preserving completed notes and pending metadata repairs for retry. Wait for settled writes and serialized saves before a re-enabled instance reads state, including across module reload. Retain recovery state after a failed final save and retry it on explicit re-enable before reading durable data.

## 1.1.1

### Patch Changes

- 3ec6f4f: One note that cannot be written no longer stops the other pages, a moved note is found only when it has the plugin markers, and a comment line that looks like a section heading is kept whole.

## 1.1.0

### Minor Changes

- 12ee134: Add the setting "Note properties" so new notes can get a created date, a link to the daily note, extra tags and your own properties.
