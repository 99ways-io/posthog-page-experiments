import { createExperiment } from '../src'

// An empty control keeps the page unchanged; test reveals and hides product sections.
createExperiment('001-product-below-addtocart-section', {
  variants: {
    test: [
      {
        selector: '#Block-location_xtjinf',
        updates: { style: { display: 'flex' } },
      },
      {
        selector: '#Block-usp_block_pBM43q',
        updates: { style: { display: 'block' } },
      },
      {
        selector: '#Block-askaquestion_MBA6pd',
        updates: { style: { display: 'block' } },
      },
      {
        selector: '.payment_methods',
        updates: { style: { display: 'none' } },
      },
      {
        selector: '#Block-sales_point',
        updates: { style: { display: 'none' } },
      },
    ],
  },
}).run()
