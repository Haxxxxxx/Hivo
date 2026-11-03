import { registerRootComponent } from 'expo';
import { createElement } from 'react';

import App from './App';
import { RootBoundary } from './src/components/RootBoundary';

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately. The root boundary turns a screen
// that throws into "Reload / Reset this phone's cache" instead of a crash loop.
registerRootComponent(() => createElement(RootBoundary, null, createElement(App)));
