# Syntax reference

| markdown | html |
|---|---|
| `# Title` | `<h1>Title</h1>` |
| `*em*`, `_em_` | `<em>em</em>` |
| `**strong**` | `<strong>strong</strong>` |
| `***both***` | `<strong><em>both</em></strong>` |
| `` `code` `` | `<code>code</code>` |
| `[text](https://x.y "title")` | `<a href="https://x.y" title="title">text</a>` |
| `![alt](/img.png)` | `<img src="/img.png" alt="alt">` |
| `<https://x.y>` | `<a href="https://x.y">https://x.y</a>` |
| `---` | `<hr>` |
| `- a` / `1. a` | `<ul>` / `<ol>` lists, nested by indentation |

Underscores inside words (`snake_case_name`) are not emphasis. A backslash escapes `* _ \` [ ] ( ) # > ! < ~ |`.

Two trailing spaces before a newline make a hard line break.
