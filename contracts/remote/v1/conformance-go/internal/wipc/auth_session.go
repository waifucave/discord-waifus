package wipc

type parentCandidate struct {
	helperNonce []byte
	helloAck    []byte
	parentProof []byte
}

type ParentAuthSession struct {
	capability    []byte
	clientNonce   []byte
	hello         []byte
	candidate     *parentCandidate
	authenticated bool
}

func copyCapability(capability []byte) ([]byte, error) {
	if len(capability) != authValueBytes {
		return nil, protocolError("invalid_auth_width", "parent capability must contain exactly 32 bytes")
	}
	return append([]byte(nil), capability...), nil
}

func eraseBytes(value []byte) {
	for index := range value {
		value[index] = 0
	}
}

func NewParentAuthSession(
	capability []byte,
	clientNonce []byte,
	hello []byte,
) (*ParentAuthSession, error) {
	capabilityCopy, err := copyCapability(capability)
	if err != nil {
		return nil, err
	}
	return &ParentAuthSession{
		capability:  capabilityCopy,
		clientNonce: append([]byte(nil), clientNonce...),
		hello:       append([]byte(nil), hello...),
	}, nil
}

func (session *ParentAuthSession) Authenticated() bool {
	return session.authenticated
}

func (session *ParentAuthSession) CapabilityAvailable() bool {
	return session.capability != nil
}

func (session *ParentAuthSession) requireCapability() ([]byte, error) {
	if session.capability == nil {
		return nil, protocolError(
			"auth_capability_unavailable",
			"the one-launch parent capability has already been consumed and erased",
		)
	}
	return session.capability, nil
}

func (session *ParentAuthSession) BeginCandidate(
	helperNonce []byte,
	helloAck []byte,
) ([]byte, error) {
	capability, err := session.requireCapability()
	if err != nil {
		return nil, err
	}
	if session.candidate != nil {
		return nil, protocolError("auth_sequence_error", "a parent authentication candidate is already active")
	}
	helperNonceCopy := append([]byte(nil), helperNonce...)
	helloAckCopy := append([]byte(nil), helloAck...)
	parentProof, err := ParentProof(
		capability,
		session.clientNonce,
		helperNonceCopy,
		session.hello,
		helloAckCopy,
	)
	if err != nil {
		return nil, err
	}
	session.candidate = &parentCandidate{
		helperNonce: helperNonceCopy,
		helloAck:    helloAckCopy,
		parentProof: parentProof,
	}
	return append([]byte(nil), parentProof...), nil
}

func (session *ParentAuthSession) clearCandidate() {
	if session.candidate == nil {
		return
	}
	eraseBytes(session.candidate.helperNonce)
	eraseBytes(session.candidate.helloAck)
	eraseBytes(session.candidate.parentProof)
	session.candidate = nil
}

func (session *ParentAuthSession) CompleteCandidate(helperProof []byte) error {
	capability, err := session.requireCapability()
	if err != nil {
		return err
	}
	if session.candidate == nil {
		return protocolError("auth_sequence_error", "no parent candidate is awaiting helper proof")
	}
	candidate := session.candidate
	verified, err := VerifyHelperProof(
		capability,
		session.clientNonce,
		candidate.helperNonce,
		session.hello,
		candidate.helloAck,
		candidate.parentProof,
		helperProof,
	)
	if err != nil {
		session.clearCandidate()
		return err
	}
	if !verified {
		session.clearCandidate()
		return protocolError("invalid_helper_proof", "helper proof does not match this exact WIPC transcript")
	}
	session.authenticated = true
	session.clearCandidate()
	eraseBytes(session.capability)
	session.capability = nil
	return nil
}

func (session *ParentAuthSession) AssertTrafficAllowed() error {
	if !session.authenticated {
		return protocolError(
			"frame_before_authentication",
			"no command, event, or stream traffic is allowed before helper proof succeeds",
		)
	}
	return nil
}

type HelperCandidate struct {
	ClientNonce []byte
	HelperNonce []byte
	Hello       []byte
	HelloAck    []byte
	ParentProof []byte
}

type HelperAuthSession struct {
	capability    []byte
	authenticated bool
}

func NewHelperAuthSession(capability []byte) (*HelperAuthSession, error) {
	capabilityCopy, err := copyCapability(capability)
	if err != nil {
		return nil, err
	}
	return &HelperAuthSession{capability: capabilityCopy}, nil
}

func (session *HelperAuthSession) Authenticated() bool {
	return session.authenticated
}

func (session *HelperAuthSession) CapabilityAvailable() bool {
	return session.capability != nil
}

func (session *HelperAuthSession) AuthenticateCandidate(candidate HelperCandidate) ([]byte, error) {
	if session.capability == nil {
		return nil, protocolError(
			"auth_capability_unavailable",
			"the one-launch helper capability has already been consumed and erased",
		)
	}
	verified, err := VerifyParentProof(
		session.capability,
		candidate.ClientNonce,
		candidate.HelperNonce,
		candidate.Hello,
		candidate.HelloAck,
		candidate.ParentProof,
	)
	if err != nil {
		return nil, err
	}
	if !verified {
		return nil, protocolError("invalid_parent_proof", "parent proof does not match this exact WIPC transcript")
	}
	helperProof, err := HelperProof(
		session.capability,
		candidate.ClientNonce,
		candidate.HelperNonce,
		candidate.Hello,
		candidate.HelloAck,
		candidate.ParentProof,
	)
	if err != nil {
		return nil, err
	}
	session.authenticated = true
	eraseBytes(session.capability)
	session.capability = nil
	return helperProof, nil
}

func (session *HelperAuthSession) AssertTrafficAllowed() error {
	if !session.authenticated {
		return protocolError(
			"frame_before_authentication",
			"no command, event, or stream traffic is allowed before parent proof succeeds",
		)
	}
	return nil
}
