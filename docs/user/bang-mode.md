# Run terminal commands from chat

On an existing thread, start a composer draft with `!` to run a shell command without starting an agent turn:

```text
! npm run prep
```

The composer changes to terminal mode. Press Enter to run the command, Shift+Enter to add another line, or Escape to remove the leading `!` and return to a normal message.

Terminal commands run in a login and interactive shell with a real terminal on the environment that owns the thread. Shell setup from files such as `.zprofile`, `.zlogin`, and `.zshrc` is available, so aliases, functions, `nvm`, and commands that emit terminal colors work as they do in a terminal. T3 Code removes its own Node and package-runner variables before starting the shell. The thread workspace is the working directory. Use a command such as `cd packages/web && npm test` when you need a subdirectory.

The output block is read-only and does not accept input. A command that opens a prompt keeps waiting until you cancel it or its configured timeout expires.

Output streams into a read-only terminal block in the thread. A command has no default timeout and can run until it exits or you select Cancel. Completed blocks show the exit status and retain a bounded output excerpt; very large logs are truncated to protect the server and connected clients. Use the copy button to copy the command, plain-text output, and status. The web client retrieves retained output before copying a truncated block. Mobile copies the retained excerpt shown in the thread.

The next agent turn receives a bounded plain-text excerpt of completed, unshared terminal commands. The excerpt is labelled as untrusted command output and is shared once, even when the command and the next turn come from different clients.

Bang mode is unavailable on a brand-new draft thread and while an agent turn is active. It accepts plain text only, without images, browser annotations, file chips, or terminal-context chips. Mobile displays terminal-command blocks, but starting a bang command from the mobile composer is not supported yet.
