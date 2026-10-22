/**
 * Headless smoke test for the browser half.
 *
 * Loads `client.js` under a stub `window.__ModuleLoader__`, captures the
 * factory, and runs `apply` against a stub Cordis context. It proves the two
 * things a syntax check cannot: that the module bundle exports the expected
 * shape, and that registration actually reaches `slots` and `locale` with the
 * ids the shell will dispatch on.
 *
 * Run: node test/client-smoke.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

/** Minimal React stand-in: the panel only needs element factories. */
const React = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  Fragment: Symbol('Fragment'),
  useState: initial => [initial, () => {}],
  useEffect: () => {},
  useCallback: fn => fn,
}

const registrations = { slots: [], locale: [], effects: [], styles: 0 }

/** A Cordis-shaped context, just wide enough for this plugin's apply(). */
const ctx = {
  locale: {
    bind: () => key => key,
    register: (ns, dict) => { registrations.locale.push({ ns, dict }); return () => {} },
  },
  slots: {
    inject: (name, invoke) => { registrations.slots.push(name); invoke() },
    register: (options, component) => {
      registrations.slots.push({ ...options, hasComponent: typeof component === 'function' })
      return () => {}
    },
  },
  effect: (run, label) => {
    registrations.effects.push(label)
    const off = run()
    return typeof off === 'function' ? off : () => {}
  },
}

// Stub the browser globals the bundle touches at load time.
globalThis.window = {}
globalThis.document = {
  createElement: () => ({ setAttribute: () => {}, remove: () => {}, set textContent(value) { registrations.styles += 1 } }),
  head: { appendChild: () => {} },
}

const source = await fs.readFile(path.join(here, '..', 'client.js'), 'utf8')

let captured = null
globalThis.window.__ModuleLoader__ = {
  load: definition => { captured = definition },
}

// Evaluate the bundle. `new Function` keeps it out of module scope so the
// `window` global it writes to is the stub above.
new Function('window', 'require', 'document', source)(
  globalThis.window,
  id => {
    if (id === 'react') return React
    throw new Error(`unexpected require("${id}")`)
  },
  globalThis.document,
)

assert.ok(captured, 'the bundle must call window.__ModuleLoader__.load')
assert.equal(captured.id, 'dsh-freellmapi')

const exported = captured.factory(id => {
  if (id === 'react') return React
  throw new Error(`unexpected require("${id}")`)
})

assert.equal(typeof exported.apply, 'function', 'exports.apply must be a function')
assert.equal(exported.name, 'freellmapi')
assert.deepEqual([...exported.inject].sort(), ['locale', 'slots'])

exported.apply(ctx)

// ── assertions ──────────────────────────────────────────────────────────────
const localeEntry = registrations.locale.find(entry => entry.ns === 'settings.freellmapi')
assert.ok(localeEntry, 'must register the settings.freellmapi dictionary')
assert.ok(localeEntry.dict.zh && localeEntry.dict.en, 'both locales must be present')
assert.equal(typeof localeEntry.dict.zh['meta.title'], 'string')
assert.equal(typeof localeEntry.dict.en['meta.description'], 'string')

// Every key must exist in both dictionaries. A missing translation renders as
// the bare key in the panel — easy to miss by eye, and visible in only one of
// the two languages.
{
  const zhKeys = Object.keys(localeEntry.dict.zh).sort()
  const enKeys = Object.keys(localeEntry.dict.en).sort()
  const missingInEn = zhKeys.filter(key => !enKeys.includes(key))
  const missingInZh = enKeys.filter(key => !zhKeys.includes(key))
  assert.deepEqual(missingInEn, [], `keys missing from en: ${missingInEn.join(', ')}`)
  assert.deepEqual(missingInZh, [], `keys missing from zh: ${missingInZh.join(', ')}`)
  assert.ok(zhKeys.length > 30, `expected a full dictionary, got ${zhKeys.length} keys`)
  console.log(`ok  locale dictionaries agree (${zhKeys.length} keys x 2 languages)`)
}

const section = registrations.slots.find(entry => typeof entry === 'object' && entry.name === 'settings.section')
assert.ok(section, 'must register into settings.section')
assert.equal(section.id, 'freellmapi')
assert.equal(typeof section.order, 'number')
assert.equal(typeof section.label, 'function')
assert.equal(section.locale, 'settings.freellmapi')
assert.equal(section.hasComponent, true, 'a settings section needs a component')

assert.ok(registrations.effects.includes('freellmapi: dictionaries'))
assert.ok(registrations.effects.includes('freellmapi: styles'))
assert.ok(registrations.styles >= 1, 'the panel stylesheet must be injected')

console.log('ok  bundle loads and exports apply/inject/name')
console.log('ok  locale dictionary registered for zh + en')
console.log('ok  settings.section registered as id=freellmapi with a component')
console.log('\nclient smoke checks passed')
