export function fakeDocument() {
  const properties = Object.create(null);
  const documentElement = {
    nodeType: 1,
    dataset: {},
    lang: '',
    closest: function () { return null; },
    hasAttribute: function () { return false; },
    getAttribute: function () { return null; },
    setAttribute: function () {},
    style: {
      setProperty: function (name, value) { properties[name] = String(value); },
      getPropertyValue: function (name) { return properties[name] || ''; }
    }
  };
  return {
    readyState: 'complete',
    documentElement: documentElement,
    properties: properties,
    createTreeWalker: function () {
      return { nextNode: function () { return null; } };
    },
    querySelector: function () { return null; },
    addEventListener: function () {}
  };
}
