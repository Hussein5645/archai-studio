# Security

Please **do not open a public issue** for security problems (for example a way to read someone
else's online project, bypass sign-in, or reach the cloud services without an account).

Email **mklkoklpp@gmail.com** with the subject "ArchAI security" and include what you found, how
to reproduce it, and what could be affected. You will get an answer as soon as possible, and
credit in the release notes if you would like it.

The hosted ArchAI cloud (accounts, online projects, libraries, VR sharing) runs the code in
[`workers/`](workers). Its secrets and data are not in this repository. Test against a local
`wrangler dev` setup (see the README), never against other people's accounts or data.
