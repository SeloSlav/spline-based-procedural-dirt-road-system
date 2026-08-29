const seedThreeRoot = new URL('../vendor/seedthree/src/', import.meta.url);

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@seedthree/')) {
    return nextResolve(new URL(specifier.slice('@seedthree/'.length), seedThreeRoot).href, context);
  }
  return nextResolve(specifier, context);
}
