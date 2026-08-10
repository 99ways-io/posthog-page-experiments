import { createExperiment } from '../src'

function injectSaleStyles() {
  if (document.querySelector('#experiment-010-cart-features')) return

  const style = document.createElement('style')
  style.id = 'experiment-010-cart-features'
  style.textContent = `
    div.free_shipping_box {
      margin-bottom: unset !important;
      margin-top: unset !important;
    }
    .free_shipping_text {
      font-size: 18px !important;
    }
    .free_shipping_text img,
    .free_shipping_text:nth-child(2) {
      display: none !important;
    }
  `
  document.head.appendChild(style)
}

function updateSaleTags() {
  document
    .querySelectorAll<HTMLElement>('.free_shipping_text:nth-child(1) > p')
    .forEach((element) => {
      element.innerText = 'Free Shipping & 30-Day Returns'
    })
}

createExperiment('010-cart-features')
  .on('control', injectSaleStyles)
  .on('control', updateSaleTags)
  .on('test', [])
  .run()
