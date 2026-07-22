const test = require('node:test')
const assert = require('node:assert/strict')
const { createBrowserAutomation } = require('../electron/browser-automation.cjs')

function fixture() {
  let attached = false
  let attachArgumentCount = null
  const commands = []
  const debuggerApi = {
    isAttached: () => attached,
    attach(...args) { attachArgumentCount = args.length; attached = true },
    detach() { attached = false },
    async sendCommand(method, params) {
      commands.push({ method, params })
      if (method === 'Accessibility.getFullAXTree') {
        return { nodes: [{ role: { value: 'button' }, name: { value: 'Save' }, backendDOMNodeId: 42 }] }
      }
      if (method === 'Runtime.evaluate' && params.expression.includes("querySelectorAll('[data-testid]')")) {
        return { result: { value: JSON.stringify([{ tag: 'button', dataTestId: 'save-button', text: 'Save' }]) } }
      }
      if (method === 'Runtime.evaluate') {
        return { result: { value: JSON.stringify({ html: '<!doctype html><html><body data-testid="page"></body></html>', text: 'Page', truncated: false }) } }
      }
      if (method === 'DOM.resolveNode') return { object: { objectId: 'remote-object-1' } }
      if (method === 'DOM.focus') return {}
      if (method === 'DOM.getBoxModel') return { model: { content: [10, 5, 20, 5, 20, 15, 10, 15] } }
      if (method === 'Input.dispatchMouseEvent') return {}
      throw new Error(`Unexpected CDP command: ${method}`)
    },
  }
  const webContents = {
    debugger: debuggerApi,
    capturePage: async () => ({ isEmpty: () => false, toPNG: () => Buffer.from('png') }),
  }
  const state = { url: 'https://example.test/', title: 'Example', loading: false }
  const manager = {
    getWebContents: () => webContents,
    getState: () => state,
    getRevision: () => 3,
  }
  return { automation: createBrowserAutomation(manager), commands, getAttachArgumentCount: () => attachArgumentCount }
}

test('uses the current promise-based Electron debugger API', async () => {
  const { automation, commands, getAttachArgumentCount } = fixture()
  const snapshot = await automation.snapshot()
  const screenshot = await automation.screenshot()
  const source = await automation.pageSource()
  await automation.click('e1')

  assert.equal(getAttachArgumentCount(), 1)
  assert.deepEqual(snapshot.elements, [{ ref: 'e1', role: 'button', name: 'Save' }])
  assert.equal(snapshot.dataTestIds[0].dataTestId, 'save-button')
  assert.equal(screenshot.data, 'cG5n')
  assert.match(source.html, /data-testid="page"/)
  const mouseDown = commands.find(({ method, params }) => method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed')
  assert.deepEqual({ x: mouseDown.params.x, y: mouseDown.params.y }, { x: 15, y: 10 })
  assert.ok(commands.some(({ method }) => method === 'Accessibility.getFullAXTree'))
  assert.equal(commands.some(({ method }) => method === 'Page.captureScreenshot'), false)
})
