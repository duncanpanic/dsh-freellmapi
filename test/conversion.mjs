/**
 * Tests for the DSH↔OpenAI value conversion and token estimation.
 *
 * These two modules had no direct tests: they were only ever exercised by
 * passing through an adapter test, which means a regression in block handling
 * or a wrong token estimate would surface as "some requests behave oddly" —
 * exactly the kind of bug a suite does not catch by accident. An audit called
 * that out, so the coverage lives here now.
 *
 * The token estimate matters most for CJK: the flat `/4` rule undercounts
 * Chinese by roughly 4x, and that number feeds quota accounting, so the error
 * lets the router believe it has budget it does not have.
 *
 * Run: node test/conversion.mjs
 */

import assert from 'node:assert/strict'

import {
  textOf,
  messageToOpenAI,
  toolsToOpenAI,
  buildChatBody,
  mapFinishReason,
  mapUsage,
} from '../src/openai.js'
import { estimateTokens } from '../src/native/tokens.js'

// ── every DSH content block, through each role that can carry it ────────────
{
  const blocks = {
    text: { type: 'text', text: 'T' },
    reasoning: { type: 'reasoning', text: 'R' },
    image: { type: 'image', attachment: { name: 'i.png' } },
    file: { type: 'file', attachment: { name: 'f.txt' } },
    'tool-call': { type: 'tool-call', id: 'c', name: 'n', arguments: '{}' },
    'tool-addition': { type: 'tool-addition', toolName: 'new' },
    'tool-removal': { type: 'tool-removal', toolName: 'old' },
  }

  // A user turn must never lose its text to an unhandled sibling block.
  for (const [type, block] of Object.entries(blocks)) {
    const out = messageToOpenAI({ role: 'user', content: [block, blocks.text] })
    assert.equal(out.length >= 1, true, `user + ${type} must still yield a message`)
    assert.ok(
      JSON.stringify(out).includes('T'),
      `user + ${type} must keep the text block`,
    )
  }
  console.log('ok  a user turn keeps its text alongside every other block type')

  // Assistant turns: text, tool calls, or both. Reasoning alone has nothing to
  // replay, so it is dropped — assert that is deliberate and does not also drop
  // a tool call sitting beside it.
  assert.deepEqual(
    messageToOpenAI({ role: 'assistant', content: [blocks.reasoning] }),
    [],
    'reasoning alone has nothing to replay',
  )
  const both = messageToOpenAI({ role: 'assistant', content: [blocks.reasoning, blocks['tool-call']] })
  assert.equal(both.length, 1)
  assert.equal(both[0].tool_calls[0].id, 'c')
  console.log('ok  assistant turns replay tool calls and drop reasoning-only turns')

  // A tool-call-only assistant message is valid OpenAI; `content` must be
  // omitted rather than sent as null.
  const callOnly = messageToOpenAI({ role: 'assistant', content: [blocks['tool-call']] })
  assert.equal(callOnly[0].content, undefined, 'content must be omitted, not null')
  assert.deepEqual(callOnly[0].tool_calls[0].function, { name: 'n', arguments: '{}' })
  console.log('ok  a tool-call-only assistant message omits content')
}

// ── tool results must never disappear ───────────────────────────────────────
{
  // With an explicit call id.
  assert.deepEqual(
    messageToOpenAI({ role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'x' }] }),
    [{ role: 'tool', tool_call_id: 'c1', content: 'x' }],
  )
  // With the id on `source`, which is the other shape DSH emits.
  assert.deepEqual(
    messageToOpenAI({ role: 'tool', source: { kind: 'tool', callId: 'c2' }, content: [{ type: 'text', text: 'x' }] }),
    [{ role: 'tool', tool_call_id: 'c2', content: 'x' }],
  )
  // Without either: dropping it would break the pairing requirement that every
  // tool_calls entry is answered, so a placeholder id is synthesized instead.
  const orphan = messageToOpenAI({ role: 'tool', content: [{ type: 'text', text: 'x' }] })
  assert.equal(orphan.length, 1, 'an unattributed tool result must not be dropped')
  assert.equal(orphan[0].role, 'tool')
  assert.ok(typeof orphan[0].tool_call_id === 'string' && orphan[0].tool_call_id !== '')
  console.log('ok  tool results survive every id shape, including none')

  // An empty tool result still needs a body: OpenAI rejects an empty string.
  assert.equal(
    messageToOpenAI({ role: 'tool', toolCallId: 'c', content: [] })[0].content,
    '(no output)',
  )
  console.log('ok  an empty tool result gets a placeholder body')
}

// ── a realistic multi-turn tool loop ────────────────────────────────────────
{
  const body = buildChatBody({
    model: 'm',
    system: 'be brief',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'read a.txt' }] },
      { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'read', arguments: '{"p":"a"}' }] },
      { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'contents' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    ],
    tools: [{ name: 'read', description: 'read a file', parameters: { type: 'object' } }],
    temperature: 0.2,
    maxTokens: 512,
    stop: ['END'],
  })
  assert.equal(body.messages.length, 5, 'system + four turns')
  assert.equal(body.messages[0].role, 'system')
  // Every tool call must be answered, or the provider rejects the whole body.
  const callIds = body.messages.flatMap(m => (m.tool_calls ?? []).map(c => c.id))
  const resultIds = body.messages.filter(m => m.role === 'tool').map(m => m.tool_call_id)
  assert.deepEqual(callIds, resultIds, 'every tool call needs a matching result')
  assert.equal(body.stream, true)
  assert.deepEqual(body.stream_options, { include_usage: true })
  assert.equal(body.temperature, 0.2)
  assert.equal(body.max_tokens, 512)
  assert.deepEqual(body.stop, ['END'])
  assert.equal(body.tools[0].type, 'function')
  assert.equal(body.tool_choice, 'auto')
  console.log('ok  a multi-turn tool loop builds a pairable body')
}

// ── tools conversion ────────────────────────────────────────────────────────
{
  assert.deepEqual(toolsToOpenAI(undefined), [])
  assert.deepEqual(toolsToOpenAI([]), [])
  // A tool with no name is unusable and would be rejected; skip it.
  assert.deepEqual(toolsToOpenAI([{ description: 'nameless' }]), [])
  // A tool with no parameters still needs a valid schema.
  const bare = toolsToOpenAI([{ name: 't' }])
  assert.deepEqual(bare[0].function.parameters, { type: 'object', properties: {} })
  console.log('ok  tools convert with safe defaults')
}

// ── finish-reason mapping ───────────────────────────────────────────────────
{
  assert.equal(mapFinishReason('stop'), 'stop')
  assert.equal(mapFinishReason('tool_calls'), 'tool-calls')
  assert.equal(mapFinishReason('function_call'), 'tool-calls')
  assert.equal(mapFinishReason('length'), 'max-tokens')
  assert.equal(mapFinishReason('max_tokens'), 'max-tokens')
  assert.equal(mapFinishReason('content_filter'), 'max-tokens')
  assert.equal(mapFinishReason(null), 'stop')
  console.log('ok  finish reasons map to DSH kinds')
}

// ── usage mapping ───────────────────────────────────────────────────────────
{
  assert.deepEqual(mapUsage({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }), {
    inputTokens: 10, outputTokens: 5, totalTokens: 15,
  })
  // Reasoning and cache details are carried when present, omitted otherwise.
  const rich = mapUsage({
    prompt_tokens: 10,
    completion_tokens: 40,
    total_tokens: 50,
    completion_tokens_details: { reasoning_tokens: 30 },
    prompt_tokens_details: { cached_tokens: 8 },
  })
  assert.equal(rich.reasoningTokens, 30)
  assert.equal(rich.cacheReadTokens, 8)
  const plain = mapUsage({ prompt_tokens: 1, completion_tokens: 1 })
  assert.equal('reasoningTokens' in plain, false, 'absent details must not add zeroed fields')
  console.log('ok  usage maps, carrying detail only when present')
}

// ── textOf ──────────────────────────────────────────────────────────────────
{
  assert.equal(textOf(undefined), '')
  assert.equal(textOf([{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }]), 'ab')
  console.log('ok  textOf joins text blocks and ignores the rest')
}

// ════════════════════════════════════════════════════════════════════════════
// Token estimation — the part that silently corrupts quota accounting
// ════════════════════════════════════════════════════════════════════════════
{
  // English prose: the classic ~4 characters per token.
  const english = 'The quick brown fox jumps over the lazy dog and runs away into the forest.'
  const englishEstimate = estimateTokens(english)
  assert.ok(
    englishEstimate >= english.length / 6 && englishEstimate <= english.length / 3,
    `English should stay near length/4, got ${englishEstimate} for ${english.length} chars`,
  )

  // CJK: one character is roughly one token. The flat rule gave 11 for a
  // 43-character sentence; anything under half the character count is the bug
  // this module exists to fix.
  const chinese = '今天天气很好我想出去走走顺便买点东西回来做饭给家人吃大家都很开心这件事让我感觉特别温暖'
  const chineseEstimate = estimateTokens(chinese)
  assert.ok(
    chineseEstimate >= chinese.length * 0.75,
    `Chinese must be counted near one token per character: got ${chineseEstimate} for ${chinese.length} chars`,
  )
  console.log(`ok  token estimate is script-aware (英文 ${englishEstimate}, 中文 ${chineseEstimate})`)

  // Japanese kana and Korean Hangul are dense too.
  assert.ok(estimateTokens('こんにちは世界') >= 6, 'kana must count densely')
  assert.ok(estimateTokens('안녕하세요세계') >= 6, 'Hangul must count densely')
  console.log('ok  kana and Hangul count densely')

  // Mixed text sits between the two, and never below the dense floor.
  const mixed = '请帮我 read the file 然后 tell me what you find 谢谢'
  const mixedEstimate = estimateTokens(mixed)
  assert.ok(mixedEstimate > mixed.length / 4, 'mixed text must not be counted as pure English')
  assert.ok(mixedEstimate <= mixed.length, 'mixed text cannot exceed one token per character')
  console.log('ok  mixed text lands between the two rules')

  // Degenerate input.
  assert.equal(estimateTokens(''), 1, 'an empty string is still at least one token')
  assert.equal(estimateTokens(undefined), 1)
  assert.equal(estimateTokens(null), 1)
  assert.equal(estimateTokens(12345), 1, 'a non-string is not a token source')
  console.log('ok  token estimate handles degenerate input')

  // The error the flat rule made, pinned so it cannot come back.
  const flatRule = Math.round(chinese.length / 4)
  assert.ok(
    estimateTokens(chinese) > flatRule * 3,
    `the script-aware estimate must beat the flat rule by a wide margin (${estimateTokens(chinese)} vs ${flatRule})`,
  )
  console.log(`ok  the fix is material (${estimateTokens(chinese)} tokens vs the flat rule's ${flatRule})`)
}

console.log('\nconversion checks passed')
