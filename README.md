
Ai

Used claude for support during backend setups, including the required tables, api routes, simulation brain and simulation world. For every ai response, I ensured that I fully read through and understood the code before testing. During prompting, the AI recommended some changes to previously existing code, however since the majority of the changes were fairly meaningless and only complicated my understanding, I chose to not include the code. 

The original output for frontend styling was also too complex, so I asked for simplification which reduced frontend code from 1146 lines down to 557. 

Also had to download git LFS for the supermarket.db, which I did without the help of AI. I tracked “*.db” files as well “*.js” files as some javascript files could also pose an issue for size. 

Also had to install git filter repo to clean the previous repo history which was trying to push the large file without LFS


-- run --

server: node index.js
host: http://localhost:4000/


client: npm run dev
host: http://localhost:5173/

-- Personal tweaks and edits --

Tweaked snacks & confectionary quantity by category from 
{ 1: 0.78, 2: 0.17, 3: 0.05 } to { 1: 0.70, 2: 0.25, 3: 0.05 }
Which made the probability of a customer selecting 2 of the same item slightly higher for the snacks and confectionary category items, as I thought it was more common for someone to select two than what was originally stated.

Tweaked weekend midnight hours to reflect celebration/party culture
From weekend: [0.008,0.005,0.003,0.002,0.002,0.005,0.015,0.030,0.055,0.075,0.090,0.095, 0.100,0.095,0.085,0.075,0.065,0.055,0.045,0.035,0.025,0.018,0.012,0.010]
To weekend: [0.010,0.008,0.004,0.002,0.002,0.005,0.015,0.030,0.055,0.075,0.090,0.095, 0.100,0.095,0.085,0.075,0.065,0.055,0.045,0.035,0.025,0.018,0.012,0.012],

Tweaked afternoon and night timebands to be more accurate for daylight savings
from timeBands: [
    { name: 'morning',   fromHour: 5,  toHour: 10 },
    { name: 'midday',    fromHour: 11, toHour: 14 },
    { name: 'afternoon', fromHour: 15, toHour: 16 },
    { name: 'evening',   fromHour: 17, toHour: 20 },
    { name: 'night',     fromHour: 21, toHour: 4 },
To  timeBands: [
    { name: 'morning',   fromHour: 5,  toHour: 10 },
    { name: 'midday',    fromHour: 11, toHour: 14 },
    { name: 'afternoon', fromHour: 15, toHour: 17 },
    { name: 'evening',   fromHour: 18, toHour: 20 },
    { name: 'night',     fromHour: 21, toHour: 4 },
