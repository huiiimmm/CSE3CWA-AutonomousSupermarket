
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

