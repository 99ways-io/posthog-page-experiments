import { runExperiment } from '../src'

// Migrated from scripts-inventory/script5.js.
// Demonstrates an element callback and two independent experiments on one page.
function getStoredFirstName(): string | null {
  try {
    const exactKey = 'garlic:go.erika.com*>input.first_name'
    const exactValue = localStorage.getItem(exactKey)
    if (exactValue) return exactValue

    const matchingKey = Object.keys(localStorage).find((key) => (
      key.startsWith('garlic:go.erika.com')
      && key.endsWith('>input.first_name')
    ))
    return matchingKey ? localStorage.getItem(matchingKey) : null
  } catch {
    return null
  }
}

function insertNameAfterOpeningQuote(element: HTMLElement, name: string): void {
  if (element.textContent?.includes(`${name}, `)) return

  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
  let node = walker.nextNode()
  while (node) {
    const text = node.nodeValue ?? ''
    const quoteIndex = text.indexOf('"')
    if (quoteIndex >= 0) {
      node.nodeValue = `${text.slice(0, quoteIndex + 1)}${name}, ${text.slice(quoteIndex + 1)}`
      return
    }
    node = walker.nextNode()
  }

  element.insertAdjacentText('afterbegin', `"${name}, `)
}

const firstName = getStoredFirstName()

runExperiment('044-fcts-sep-tripwire-headline', {
  variants: {
    test: [
      {
        selector: '#headline-90710 h1',
        updates: {
          callback: (element) => {
            if (firstName) insertNameAfterOpeningQuote(element, firstName)
          },
        },
      },
    ],
  },
})

runExperiment('045-fcts-sep-tripwire-countdown', {
  variants: {
    test: [
      {
        selector: '#row--28100',
        updates: { style: { display: 'none' } },
      },
      {
        selector: '#row--87697',
        updates: { style: { display: 'block' } },
      },
    ],
  },
});
