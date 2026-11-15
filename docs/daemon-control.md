# Daemon control channel

Sam's daemon accepts two commands on a local endpoint: `ping` and `stop`. The endpoint is a Unix socket at `<workspace>/.sam/daemon.sock` or, on Windows, a named pipe whose name is a SHA-256 prefix of the workspace path. This note is the threat model for that channel.

## What is authorized

Every command must present the per-installation control token, a fresh 16-byte nonce, and a timestamp within 60 seconds of the daemon clock. The daemon remembers nonces it has accepted (bounded to the newest 256) and rejects a repeat. A request with the wrong token, a missing token, a stale timestamp, or a reused nonce does not ping and does not stop the process.

The TypeScript CLI (`sam daemon status`, `sam daemon stop`, `sam daemon serve`) reads the token from the install file and sends it on the socket. The token is not a command-line argument. The Rust CLI does not open this channel.

## Where the token lives

The token is 32 random bytes, hex-encoded, in a file under the SAM vault directory (`SAM_VAULT_DIR`, or `<parent of workspace>/.sam-vault/daemon/<workspace hash>`). The directory is mode 0700 and the file is mode 0600 on Unix. The file is outside `.sam`, so a state backup does not take it. It is not a row in the vault credential table: those rows are keys the owner deposited, and this token is minted by the install. No command prints it. Errors from the channel name the refusal (`Unauthorized`, `Replay rejected`, `Stale request`) and do not echo the request.

## What the operating system still has to do

On Unix the `.sam` directory is mode 0700 and the socket is mode 0600, so another user cannot connect. The token check is still required: it refuses a same-machine client that can reach the socket but does not have the install's token file.

On Windows, Node's `net` module creates the named pipe with a null security descriptor and does not expose a handle SAM can put a DACL on. SAM does not claim that the pipe ACL denies other users. A process that can open the pipe still cannot `ping` or `stop` without the token. The token file's protection on Windows is best-effort (`chmod` is not an NTFS ACL). A local user who can read that file can control the daemon. That is the owner-only limit: control belongs to processes that can read the install's token, which is the owner's account.

## What a captured request can still do

A request sniffed from a same-user process can be replayed until its timestamp is older than 60 seconds, and only if the daemon has not already seen that nonce. The nonce memory is in the daemon process. After a restart the memory is empty, and a captured request is still rejected once its timestamp leaves the 60-second window. SAM does not claim resistance to a same-user attacker who can read the token file: that attacker is inside the owner boundary and can mint a fresh request.

## What this is not

The channel is not a remote API, not a multi-user service, and not a place for model keys or vault secrets. It starts and stops the local daemon and reports pid, instance, uptime, and the version the process loaded.
