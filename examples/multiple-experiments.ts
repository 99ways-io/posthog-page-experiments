import { runExperiment } from '@99ways/posthog-page-experiments'

const headline = runExperiment('landing-page-headline', {
  isEligible: () => document.querySelector('[data-hero-title]') !== null,
  variants: {
    control: [],
    concise: [
      {
        selector: '[data-hero-title]',
        updates: { innerText: 'Build the right thing sooner' },
      },
    ],
  },
})

const proof = runExperiment('landing-page-proof', {
  isEligible: () => document.querySelector('[data-proof]') !== null,
  variants: {
    control: [],
    reordered: [
      {
        selector: '[data-proof]',
        updates: { style: { order: '-1' } },
      },
    ],
  },
})

console.log(await Promise.all([headline, proof]))
