import { createExperiment } from '../src'

const experiment = createExperiment('example-all-configurations', {
  defaultVariant: 'baseline',
  variants: {
    'copy-test': [
      {
        selector: '.experiment-title',
        updates: { innerText: 'A plain-text headline' },
      },
      {
        selector: '.experiment-description',
        updates: { innerHTML: 'Save <strong>40%</strong> today' },
      },
    ],
  },
})

experiment
  .on('design-test', [
    {
      selector: '.experiment-card',
      updates: {
        style: {
          backgroundColor: '#111827',
          color: '#ffffff',
          padding: 24,
        },
        callback: (element, activeVariant) => {
          element.dataset.experimentVariant = activeVariant
        },
      },
    },
  ])
  // Multiple handlers may be registered for the same variant.
  .on('design-test', () => {
    document.documentElement.dataset.hasExperiment = 'true'
  })

experiment.run().then((activeVariant) => {
  console.info(`Applied example-all-configurations: ${activeVariant}`)
})
