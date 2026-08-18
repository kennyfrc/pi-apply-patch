# pi-apply-patch

OpenAI Codex `apply_patch` file-editing tool for Pi, active only for GPT-family
models, where it replaces the built-in `edit` and `write` tools.

## Install

```bash
pi install npm:pi-apply-patch
```

Config lives in `~/.pi/agent/pi-apply-patch.json`. Omit it for the default
`auto` mode.

```json
{
  "mode": "auto",
  "gptIdPatterns": ["^gpt", "^o\\d"]
}
```

`mode` is `auto` (default), `on`, or `off`:

- `auto`: enables `apply_patch` and removes `edit` and `write` for GPT-family
  models; every other model keeps `edit`/`write` and has `apply_patch` hidden.
- `on`: enables `apply_patch` for every model.
- `off`: disables `apply_patch` for every model.

`gptIdPatterns` are regexes tested against the model id. Models whose api is
`openai-codex-responses` always count as GPT.

## License

MIT.
