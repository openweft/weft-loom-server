// Package auth bridges OIDC (dex) bearers to a typed Identity passed
// through req.Context. V0.1 implements the Verifier interface as a
// JWKS-fetching JWT validator ; dev mode bypasses the layer entirely
// via Server.Auth=nil.
package auth

import (
	"context"
	"errors"
	"fmt"
)

// Identity is the request-scoped principal we extract from a verified
// OIDC token. Subject is the dex subject claim (sub). Groups carry
// the operator's group memberships ; we map those to project ACL.
type Identity struct {
	Subject string
	Groups  []string
}

// HasGroup reports whether the identity is in g. Convenience for
// ACL checks.
func (i Identity) HasGroup(g string) bool {
	for _, x := range i.Groups {
		if x == g {
			return true
		}
	}
	return false
}

type ctxKey int

const identityKey ctxKey = 1

// WithIdentity attaches ident to ctx so downstream handlers can pull
// it back with IdentityFrom.
func WithIdentity(ctx context.Context, ident Identity) context.Context {
	return context.WithValue(ctx, identityKey, ident)
}

// IdentityFrom retrieves the identity attached by WithIdentity. When
// no identity is present, returns the zero Identity + false.
func IdentityFrom(ctx context.Context) (Identity, bool) {
	v, ok := ctx.Value(identityKey).(Identity)
	return v, ok
}

// Verifier validates a bearer token and returns the corresponding
// Identity. V0.1 has one impl (OIDC via dex) ; tests can drop in a
// fake by implementing the interface directly.
type Verifier interface {
	Verify(ctx context.Context, bearer string) (Identity, error)
}

// ErrInvalidToken is the standard error for a malformed / expired /
// unverifiable token. Handlers translate this to 401.
var ErrInvalidToken = errors.New("auth: invalid token")

// StaticVerifier is a test/dev verifier that accepts a fixed token
// and returns a fixed identity. Useful for local development without
// dex configured.
type StaticVerifier struct {
	Token    string
	Identity Identity
}

func (s StaticVerifier) Verify(_ context.Context, bearer string) (Identity, error) {
	if bearer != s.Token {
		return Identity{}, fmt.Errorf("%w: token mismatch", ErrInvalidToken)
	}
	return s.Identity, nil
}
