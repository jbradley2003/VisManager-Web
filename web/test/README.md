# Web tests

Headless checks that catch the class of bug that shipped a blank UI: a
ReferenceError early in `app.js` aborts the whole script, so no event
handlers attach and every button silently does nothing.

```bash
npm install jsdom     # one-off
node test/load.test.js    # scripts parse, handlers attach, icons inject
node test/smoke.test.js   # ingest -> mark -> navigate -> remove -> export
```

Both exit non-zero on failure, so they work as a CI gate.
