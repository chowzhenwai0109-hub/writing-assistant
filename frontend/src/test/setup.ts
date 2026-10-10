import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach, vi } from 'vitest'

// jsdom lacks the native dialog lifecycle. Browser verification covers the
// actual modal, focus behavior and Escape; these shims expose its content here.
if (!HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open') }
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
