# mdlite

A small Markdown → HTML converter. Zero dependencies.

```js
import { render } from 'mdlite';

render('# Hello\n\nSome *emphasis* and `code`.');
// <h1>Hello</h1>
// <p>Some <em>emphasis</em> and <code>code</code>.</p>
```

## Supported syntax

See [docs/syntax.md](docs/syntax.md). In short: ATX and setext headings, paragraphs, fenced code, block quotes, horizontal rules,
bullet and ordered lists (nested), emphasis, strong, inline code, links, images, autolinks, hard line breaks.

## Layout

| path | role |
|---|---|
| `src/parser/block.js` | line-based block parser |
| `src/parser/lists.js` | list and list-item parsing |
| `src/parser/inline.js` | inline scanner (emphasis, code, links, images) |
| `src/parser/escape.js` | `escapeHtml` |
| `src/renderer/html.js` | HTML renderer, URL sanitising, helper renderers for plugins |
| `src/renderer/text.js` | plain-text renderer |
| `src/plugins/` | table of contents and heading anchors |

## Options

`render(markdown, { plugins: [], anchors: false })`. A plugin is `(blocks) => blocks` and runs between parsing and rendering.

## Security

Raw HTML in the source is escaped. URLs in links and images are sanitised by `sanitizeUrl` (`src/renderer/html.js`): only
`http:`, `https:` and relative URLs survive; anything else becomes `#`.

## Tests

`npm test`.
