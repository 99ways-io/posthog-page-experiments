import { runExperiment } from '../src'

const experiment = runExperiment('example-all-configurations', {
  debug: true,
  featureFlagTimeoutMs: 4_000,
  defaultVariant: 'baseline',
  variants: {
    baseline: [],
    'copy-test': [
      {
        selector: '.experiment-title',
        updates: {
          innerText: 'A plain-text headline'
        },
      },
      {
        selector: '.experiment-description',
        updates: { innerHTML: 'Save <strong>40%</strong> today' },
      },
    ],
    'design-test': [
      {
        selector: '.experiment-card',
        updates: {
          style: {
            backgroundColor: '#111827',
            color: '#ffffff',
            padding: '24px',
          },
          callback: (element, activeVariant) => {
            element.dataset.experimentVariant = activeVariant
          },
        },
      },
      () => {
        document.documentElement.dataset.hasExperiment = 'true'
      }
    ]
  },
}).then((activeVariant) => {
  console.info(`Applied example-all-configurations: ${activeVariant}`)
})

