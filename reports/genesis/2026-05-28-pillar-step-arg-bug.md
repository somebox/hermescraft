# `mc pillar_step --force` arg-parse bug

**Observed:** `g-2026-05-28-5`, Mason trapped in shelter at 18:02:11.
**Severity:** Blocks the documented "trapped in self-built shelter" escape
path. `mc dig --force` is the working alternate.
**Symptom:**

```
$ mc pillar_step 2 --force
ERROR (cli): pillar_step:count:not_number

$ mc pillar_step 8 --force
ERROR (cli): pillar_step:count:not_number

$ mc pillar_step --force
ERROR (cli): pillar_step:count:not_number
```

The same error fires regardless of whether a numeric count is passed.

## Root cause

`pillar_step`'s argSchema declares `force` and `jump` as `type: 'string'`
instead of `type: 'boolean'` (`bot/cli/registry.mjs:325-374`):

```js
g('pillar_step', 'world', ['tower', 'pillar'], {
  argSchema: [
    { key: 'block', type: 'string' },
    { key: 'count', type: 'number', description: '...' },
    { key: 'jump',  type: 'string', description: 'true|false — ...' },   // ← bug
    { key: 'force', type: 'string', description: 'true|false — ...' },   // ← bug
  ],
  ...
});
```

In `bot/cli/args.mjs:234-238`, the flag parser only treats `--KEY` as a
boolean flag when `specByKey[KEY].type === 'boolean'`:

```js
m = t.match(/^--([A-Za-z_][A-Za-z0-9_]*)$/);
if (m && specByKey[m[1]]?.type === 'boolean') {
  kwOverrides[m[1]] = 'true';
  continue;
}
```

Because `force.type === 'string'` (not `'boolean'`), the parser doesn't
recognize `--force` as a flag — it drops into the `remaining` array as a
positional. Then positional consumption tries to coerce `"--force"` into
the `count` slot (which IS declared `type: 'number'`), `Number("--force")`
returns NaN, and `coerceValue` throws `not_number` (line 147).

The wrapping in `positionalToParams` line 264 produces the observed format:
`${commandName}:${spec.key}:${error_message}` → `pillar_step:count:not_number`.

Walk through `mc pillar_step 2 --force`:

1. Tokens after strip: `["2", "--force"]`
2. `"2"` doesn't match any flag pattern → `remaining.push("2")`
3. `"--force"` matches `^--KEY$` but `specByKey.force.type !== 'boolean'`
   → falls through → `remaining.push("--force")`
4. Positional consumption: `block ← "2"` (string, OK)
5. `count ← "--force"` → `Number("--force")` = NaN → `throw new Error('not_number')`
6. Wrapped → `pillar_step:count:not_number`

## Same bug in `mc pillar_down`

`pillar_down` has the same pattern with `pickup` declared as `type: 'string'`:

```js
g('pillar_down', 'world', ['descend', 'pillardown'], {
  argSchema: [
    { key: 'count',  type: 'number', description: 'max blocks to descend ...' },
    { key: 'pickup', type: 'string', description: 'true|false — ...' },   // ← same bug
  ],
  ...
});
```

`mc pillar_down --pickup` would fail with `pillar_down:count:not_number` for
the same reason.

## Fix

Change the schema entries to `type: 'boolean'` in `bot/cli/registry.mjs`:

```js
// pillar_step:
{ key: 'jump',  type: 'boolean', description: 'jump after placing (default true)' },
{ key: 'force', type: 'boolean', description: 'bypass slow-dig refusal + region/global denylist when genuinely stuck (default false)' },

// pillar_down:
{ key: 'pickup', type: 'boolean', description: 'pickup drops as you go (default true)' },
```

After this change, `coerceValue` for type='boolean' (`args.mjs:153-159`)
handles `'true'/'1'/'yes'` → true and `'false'/'0'/'no'` → false. The
existing bodyFn already accepts both string and boolean forms:

```js
force: p.force === true || `${p.force}`.toLowerCase() === 'true' || `${p.force}` === '1',
```

So no bodyFn change needed.

## Side effects to check

1. **`mc pillar_step true 5`** — the old type='string' would accept this
   shape (block="true", count=5, then bodyFn converts numeric block to
   count). After the change, "true" as the first positional would
   coerce to boolean for `jump`/`force` if it were a flag, but as a
   positional it goes to `block` (still type='string'). Unchanged.

2. **`mc pillar_step block=cobble force=true`** — both syntaxes work.
   `force=true` → string "true" → boolean true via the kw= path. After
   the change, the coerceValue('true') path returns boolean true
   directly. Equivalent.

3. **Existing tests** at `bot/test/actions/pillar*.test.js` (if any) —
   need to verify they don't pass strings into the boolean slots.

## How to verify the fix

```bash
# Build/lint
node -c bot/cli/registry.mjs

# Manual test against a running bot
mc pillar_step --force           # should accept; count defaults to 1
mc pillar_step 5 --force         # should accept; count=5, force=true
mc pillar_step --force --jump    # both flags should be true
mc pillar_down --pickup          # should accept; pickup=true (default)
mc pillar_down 10 --pickup       # count=10, pickup=true
```

## Lower-priority follow-up

Other commands in registry.mjs that use `type: 'string'` with
`'true|false'` in the description likely have the same bug class.
A quick grep for `type: 'string', description: 'true|false`:

```bash
grep -n "type: 'string'.*description.*'true|false" bot/cli/registry.mjs
```

…would find them in one pass. Fix as a batch if there are more.
