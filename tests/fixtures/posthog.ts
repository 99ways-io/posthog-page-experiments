import posthog from 'posthog-js'
import type { PostHogConfig } from 'posthog-js'

declare global {
  interface Window {
    /** Set by a test page before this script runs to override the client configuration. */
    posthogTestConfig?: Partial<PostHogConfig>
  }
}

const client = posthog.init('phc_browser_test', {
  api_host: 'https://example.invalid',
  autocapture: false,
  before_send: () => null,
  bootstrap: {
    distinctID: 'browser-test-user',
    isIdentifiedID: true,
    featureFlags: {
      'browser-bundle-test': 'test',
    },
    featureFlagPayloads: {},
  },
  capture_pageleave: false,
  capture_pageview: false,
  disable_session_recording: true,
  disable_surveys: true,
  persistence: 'memory',
  ...window.posthogTestConfig,
})

window.posthog = client
