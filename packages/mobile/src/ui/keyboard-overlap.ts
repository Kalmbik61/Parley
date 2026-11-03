/**
 * How far the keyboard reaches up from the bottom of the screen: window height minus the keyboard's top, never negative.
 * For a view whose bottom is the bottom of the screen (a screen body, or a sheet body: an iPhone sheet reaches the screen
 * bottom), that is how far the keyboard covers it (plan A35e).
 */
export const keyboardRise = (windowHeight: number, keyboardTop: number): number => Math.max(0, Math.round(windowHeight - keyboardTop));
