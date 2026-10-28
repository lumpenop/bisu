#!/usr/bin/env node
// PreToolUse hook for bisu ui chats: work handed to the developer, publisher, refactorer or researcher agent always runs in the
// background, so the assistant's turn ends and the person can keep talking while the agent works. Claude Code wakes the
// assistant again with the agent's result. Other agents (mac, the built-in ones) and other tools are left alone.
let s='';
process.stdin.on('data',d=>s+=d).on('end',()=>{
 let j;try{j=JSON.parse(s)}catch{return}
 const input=j.tool_input||{};
 if(!['Agent','Task'].includes(j.tool_name)||!['developer','publisher','refactorer','researcher'].includes(input.subagent_type)||input.run_in_background===true)return;
 process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',updatedInput:{...input,run_in_background:true}}}));
});
