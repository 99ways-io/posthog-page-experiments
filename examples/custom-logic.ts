import { runExperiment } from '@99ways/posthog-page-experiments'

function addExperimentClass(): void {
  document.documentElement.classList.add('has-compact-checkout')
}

function annotateCheckout(): void {
  document
    .querySelectorAll<HTMLElement>('[data-checkout-card]')
    .forEach((element) => {
      element.dataset.experiment = 'compact-checkout'
    })
}

await runExperiment('compact-checkout', {
  isEligible: () => document.querySelector('[data-checkout]') !== null,
  variants: {
    control: [],
    test: [addExperimentClass, annotateCheckout],
  },
})
