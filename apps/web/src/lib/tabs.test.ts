import { describe, expect, it } from 'vitest';
import { closeTab, frontTab, neighbour, openFresh, parseTabs, showProject, type Tabs } from './tabs';

const none: Tabs = { closed: [], fresh: [], front: null };

describe('tabs', () => {
  it('nothing stored, or something that is not tabs, means every project has its tab and no new tab is open', () => {
    expect(parseTabs(null)).toEqual(none);
    expect(parseTabs('{broken')).toEqual(none);
    expect(parseTabs('{"closed":"p1","fresh":[1,"c1"]}')).toEqual({ closed: [], fresh: ['c1'], front: null });
    expect(parseTabs('{"closed":["p1"],"fresh":["c1"],"front":"c1"}')).toEqual({ closed: ['p1'], fresh: ['c1'], front: 'c1' });
  });

  it('the selected project is in front, unless a new tab is, or its tab was closed', () => {
    expect(frontTab(none, { id: 'p1' })).toEqual({ project: 'p1' });
    expect(frontTab({ ...none, fresh: ['c1'], front: 'c1' }, { id: 'p1' })).toEqual({ fresh: 'c1' });
    // a new tab that is gone is not in front
    expect(frontTab({ ...none, front: 'c1' }, { id: 'p1' })).toEqual({ project: 'p1' });
    expect(frontTab({ ...none, closed: ['p1'] }, { id: 'p1' })).toBeNull();
    expect(frontTab(none, undefined)).toBeNull();
  });

  it('closing a tab hides a project and forgets a new tab', () => {
    const tabs: Tabs = { closed: [], fresh: ['c1', 'c2'], front: 'c2' };
    expect(closeTab(tabs, 'p1')).toEqual({ closed: ['p1'], fresh: ['c1', 'c2'], front: 'c2' });
    expect(closeTab(tabs, 'c1')).toEqual({ closed: [], fresh: ['c2'], front: 'c2' });
    expect(closeTab(tabs, 'c2')).toEqual({ closed: [], fresh: ['c1'], front: null });
  });

  it('after the tab in front is closed, the one to its right comes forward, else the one to its left', () => {
    expect(neighbour(['a', 'b', 'c'], 'b')).toBe('c');
    expect(neighbour(['a', 'b', 'c'], 'c')).toBe('b');
    expect(neighbour(['a'], 'a')).toBeNull();
  });

  it('showing a project reopens its tab and puts it in front of a new tab', () => {
    expect(showProject({ closed: ['p1', 'p2'], fresh: ['c1'], front: 'c1' }, 'p1')).toEqual({ closed: ['p2'], fresh: ['c1'], front: null });
  });

  it('a new tab opens in front, after the others', () => {
    expect(openFresh({ closed: [], fresh: ['c1'], front: null }, 'c2')).toEqual({ closed: [], fresh: ['c1', 'c2'], front: 'c2' });
  });
});
