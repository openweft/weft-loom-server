module github.com/openweft/weft-loom-server

go 1.26.4

require (
	github.com/coder/websocket v1.8.15
	github.com/danielgtaylor/huma/v2 v2.38.0
	github.com/go-git/go-git/v5 v5.19.1
	github.com/hashicorp/hcl/v2 v2.23.0
	github.com/jackc/pgx/v5 v5.10.0
	github.com/openweft/weft-microvm-agent v0.0.0-00010101000000-000000000000
	github.com/openweft/weft-slognats v0.3.0
	github.com/spf13/cobra v1.10.2
)

require (
	github.com/andybalholm/brotli v1.2.2
	github.com/creack/pty v1.1.24
	github.com/go-crdt/collab v0.25.0
	github.com/go-crdt/collab/pgstore v0.2.0
	github.com/go-crdt/crdt v0.31.0
	github.com/nats-io/nats-server/v2 v2.14.2
	github.com/opencontainers/image-spec v1.1.1
	github.com/tetratelabs/wazero v1.12.0
	oras.land/oras-go/v2 v2.6.1
)

require (
	github.com/antithesishq/antithesis-sdk-go v0.7.0-default-no-op // indirect
	github.com/google/go-tpm v0.9.8 // indirect
	github.com/minio/highwayhash v1.0.4 // indirect
	github.com/nats-io/jwt/v2 v2.8.2 // indirect
	github.com/opencontainers/go-digest v1.0.0 // indirect
	golang.org/x/time v0.15.0 // indirect
	google.golang.org/genproto/googleapis/rpc v0.0.0-20260226221140-a57be14db171 // indirect
	google.golang.org/grpc v1.81.1 // indirect
	google.golang.org/protobuf v1.36.12 // indirect
)

require (
	dario.cat/mergo v1.0.0 // indirect
	github.com/Microsoft/go-winio v0.6.2 // indirect
	github.com/ProtonMail/go-crypto v1.1.6 // indirect
	github.com/agext/levenshtein v1.2.1 // indirect
	github.com/apparentlymart/go-textseg/v13 v13.0.0 // indirect
	github.com/apparentlymart/go-textseg/v15 v15.0.0 // indirect
	github.com/cloudflare/circl v1.6.3 // indirect
	github.com/cyphar/filepath-securejoin v0.6.1 // indirect
	github.com/emirpasic/gods v1.18.1 // indirect
	github.com/go-git/gcfg v1.5.1-0.20230307220236-3a3c6141e376 // indirect
	github.com/go-git/go-billy/v5 v5.9.0 // indirect
	github.com/golang/groupcache v0.0.0-20241129210726-2c02b8208cf8 // indirect
	github.com/google/go-cmp v0.7.0 // indirect
	github.com/inconshreveable/mousetrap v1.1.0 // indirect
	github.com/jackc/pgpassfile v1.0.0 // indirect
	github.com/jackc/pgservicefile v0.0.0-20240606120523-5a60cdf6a761 // indirect
	github.com/jackc/puddle/v2 v2.2.2 // indirect
	github.com/jbenet/go-context v0.0.0-20150711004518-d14ea06fba99 // indirect
	github.com/kevinburke/ssh_config v1.2.0 // indirect
	github.com/klauspost/compress v1.18.6 // indirect
	github.com/klauspost/cpuid/v2 v2.3.0 // indirect
	github.com/mitchellh/go-wordwrap v0.0.0-20150314170334-ad45545899c7 // indirect
	github.com/nats-io/nats.go v1.52.0
	github.com/nats-io/nkeys v0.4.16 // indirect
	github.com/nats-io/nuid v1.0.1 // indirect
	github.com/openweft/weft-microvm-init v0.2.4
	github.com/pjbgf/sha1cd v0.6.0 // indirect
	github.com/sergi/go-diff v1.3.2-0.20230802210424-5b0b94c5c0d3 // indirect
	github.com/skeema/knownhosts v1.3.1 // indirect
	github.com/spf13/pflag v1.0.10 // indirect
	github.com/xanzy/ssh-agent v0.3.3 // indirect
	github.com/zclconf/go-cty v1.13.0 // indirect
	golang.org/x/crypto v0.52.0 // indirect
	golang.org/x/mod v0.35.0 // indirect
	golang.org/x/net v0.54.0 // indirect
	golang.org/x/sync v0.20.0 // indirect
	golang.org/x/sys v0.45.0 // indirect
	golang.org/x/text v0.37.0 // indirect
	golang.org/x/tools v0.44.0 // indirect
	gopkg.in/warnings.v0 v0.1.2 // indirect
)

replace github.com/openweft/weft-microvm-init => ../weft-microvm-init

replace github.com/openweft/weft-microvm-agent => ../weft-microvm-agent
