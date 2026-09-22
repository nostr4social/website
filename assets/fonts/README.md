# Self-hosted fonts

Both files are the `latin` subset only, taken from Google Fonts on 2026-09-22.
They are served from this origin so the site makes no third-party requests.

| File | Family | Axis / weight | Source |
| --- | --- | --- | --- |
| `archivo-latin-wght.woff2` | Archivo v25 | variable, `wght` 400–800 | `https://fonts.gstatic.com/s/archivo/v25/k3kPo8UDI-1M0wlSV9XAw6lQkqWY8Q82sLydOxI.woff2` |
| `ibm-plex-mono-latin-400.woff2` | IBM Plex Mono v20 | 400 | `https://fonts.gstatic.com/s/ibmplexmono/v20/-F63fjptAgt5VM-kVkqdyU8n1i8q1w.woff2` |

Both are licensed under the SIL Open Font License 1.1 — see `OFL-Archivo.txt`
and `OFL-IBMPlexMono.txt`.

To refresh, request the CSS with a current browser `User-Agent` and take the
`latin` block's URL:

```sh
curl -A "$UA" "https://fonts.googleapis.com/css2?family=Archivo:wght@400..800&family=IBM+Plex+Mono:wght@400&display=swap"
```
