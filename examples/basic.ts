import { runExperiment } from '@99ways/posthog-page-experiments'

await runExperiment('pricing-page-headline', {
  isEligible: () => document.querySelector('.pricing-hero') !== null,
  variants: {
    control: [],
    test: [
      {
        selector: '.pricing-hero h1',
        updates: { innerText: 'A clearer reason to choose the product' },
      },
    ],
  },
})
