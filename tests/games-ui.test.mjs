import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

test('games UI: library, match length, locked picks, reveals and rematches', async () => {
 const dom = new JSDOM('<div id="root"></div>', {url:'http://localhost'});
 for(const key of ['window','document','HTMLElement','Event','MouseEvent']) globalThis[key]=dom.window[key];
 globalThis.IS_REACT_ACT_ENVIRONMENT=true;
 const {default:React,act}=await import('react');
 const {createRoot}=await import('react-dom/client');
 const server=await createServer({server:{middlewareMode:true,hmr:false,ws:false}});
 const root=createRoot(document.getElementById('root'));
 try {
  const {GamesView}=await server.ssrLoadModule('/src/components/games/GamesView.tsx');
  const calls=[];
  const games={data:{matches:[],wins:{}},error:null,busy:false,match:undefined,select:id=>calls.push(id),start:(...args)=>calls.push(args),play:(...args)=>calls.push(args),refresh:()=>{}};
  const render=()=>act(async()=>root.render(React.createElement(GamesView,{games,userId:'a',partnerName:'Bob'})));
  const button=text=>[...document.querySelectorAll('button')].find(b=>b.textContent===text);
  await render();
  assert.equal(document.body.textContent.includes('Tic Tac Toe'), false, 'the retired game is absent from the library');
  await act(async()=>button('Best of 5').click());
  // The Rock Paper Scissors card, whatever else the library is offering: its own play
  // button is the last button inside its card.
  const rpsCard=[...document.querySelectorAll('article')].find(card=>card.textContent.includes('Rock Paper Scissors'));
  await act(async()=>[...rpsCard.querySelectorAll('button')].at(-1).click());
  assert.deepEqual(calls.pop(),['rock-paper-scissors',5]);
  games.match={id:'m',game:'rock-paper-scissors',player_x:'a',player_o:'b',best_of:5,round:1,rounds:[],my_pick:'rock',score_x:0,score_o:0,finished:false};
  await render();
  assert(document.body.textContent.includes('Your rock is locked'));
  assert([...document.querySelectorAll('.rps-picks button')].every(b=>b.disabled));
  games.match={...games.match,my_pick:null,rounds:[{round:1,x:'rock',o:'scissors',winner:'a'}]};
  await render();
  assert(document.body.textContent.includes('You: rock · Bob: scissors'));
  games.match={...games.match,finished:true,winner_id:'a'};
  await render();
  assert(document.body.textContent.includes('You won!'));
  assert(button('Play again'), 'a completed game can always be replayed');
  await act(async()=>button('Play again').click());
  assert.deepEqual(calls.pop(),['rock-paper-scissors',5]);
  assert.equal(document.body.textContent.includes('Daily challenge'), false, 'Games contains no daily challenge copy');
 } finally {await act(async()=>root.unmount());await server.close();dom.window.close();}
});
