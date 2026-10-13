package ztail

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"github.com/ImSingee/ztail/web"
)

// MessageInfo is independent of the browser locale. Args hold unmodified
// technical data or nested messages; policy actions never depend on display text.
type MessageInfo struct {
	Key    string `json:"key"`
	Args   []any  `json:"args,omitempty"`
	Action string `json:"action,omitempty"`
}

var argumentPattern = regexp.MustCompile(`\{[0-9]+\}`)
var englishMessages = func() map[string]string {
	var messages map[string]string
	if err := json.Unmarshal(web.Messages, &messages); err != nil {
		panic(err)
	}
	return messages
}()
var policyMessages = map[string]bool{
	"Service undefined or not visible to this node. Define svc:{0} and configure its access policy.":                                                       true,
	"Service must define only {0} (or do-not-validate). ztail does not overwrite existing definitions. Change the ports in the console or use a new name.": true,
	"Service not defined. Create it in the Tailscale console or enable API creation":                                                                       true,
}

func messageInfo(key string, args ...any) *MessageInfo {
	info := &MessageInfo{Key: key}
	if policyMessages[key] {
		info.Action = "policy"
	}
	for _, arg := range args {
		if err, ok := arg.(error); ok {
			if nested := errorMessage(err); nested != nil {
				info.Args = append(info.Args, nested)
			} else {
				info.Args = append(info.Args, err.Error())
			}
		} else {
			info.Args = append(info.Args, arg)
		}
		if nested, ok := info.Args[len(info.Args)-1].(*MessageInfo); ok && nested.Action == "policy" {
			info.Action = "policy"
		}
	}
	return info
}
func (m *MessageInfo) Text() string {
	text := m.Key
	if translated, ok := englishMessages[m.Key]; ok {
		text = translated
	}
	text = argumentPattern.ReplaceAllStringFunc(text, func(token string) string {
		index, _ := strconv.Atoi(token[1 : len(token)-1])
		if index >= len(m.Args) {
			return token
		}
		arg := m.Args[index]
		if nested, ok := arg.(*MessageInfo); ok {
			return nested.Text()
		}
		return fmt.Sprint(arg)
	})
	return text
}

type translatedError struct {
	info  *MessageInfo
	cause error
}

func (e *translatedError) Error() string { return e.info.Text() }
func (e *translatedError) Unwrap() error { return e.cause }
func messageError(key string, args ...any) error {
	e := &translatedError{info: messageInfo(key, args...)}
	for _, arg := range args {
		if cause, ok := arg.(error); ok {
			e.cause = cause
			break
		}
	}
	return e
}
func errorMessage(err error) *MessageInfo {
	if err == nil {
		return nil
	}
	if joined, ok := err.(interface{ Unwrap() []error }); ok {
		var args []any
		var parts []string
		for index, cause := range joined.Unwrap() {
			info := errorMessage(cause)
			if info == nil {
				args = append(args, cause.Error())
			} else {
				args = append(args, info)
			}
			parts = append(parts, "{"+strconv.Itoa(index)+"}")
		}
		return messageInfo(strings.Join(parts, "\n"), args...)
	}
	var translated *translatedError
	if errors.As(err, &translated) {
		return translated.info
	}
	return textMessage(err.Error())
}
func textMessage(text string) *MessageInfo {
	if _, ok := englishMessages[text]; ok && text != "" {
		return messageInfo(text)
	}
	return nil
}

// Copy and redact nested metadata as well as the legacy error text.
func redactMessage(info *MessageInfo, redact func(string) string) *MessageInfo {
	if info == nil {
		return nil
	}
	out := &MessageInfo{Key: redact(info.Key), Action: info.Action}
	for _, arg := range info.Args {
		switch value := arg.(type) {
		case *MessageInfo:
			out.Args = append(out.Args, redactMessage(value, redact))
		case string:
			out.Args = append(out.Args, redact(value))
		default:
			out.Args = append(out.Args, arg)
		}
	}
	return out
}

// Restore nested descriptors from persisted withdrawals without turning them into
// untyped maps. Raw technical arguments remain strings or numbers.
func (m *MessageInfo) UnmarshalJSON(data []byte) error {
	var raw struct {
		Key    string            `json:"key"`
		Action string            `json:"action"`
		Args   []json.RawMessage `json:"args"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	m.Key, m.Action, m.Args = raw.Key, raw.Action, nil
	for _, data := range raw.Args {
		var value any
		if len(data) > 0 && data[0] == '{' {
			value = &MessageInfo{}
		}
		if value != nil {
			if err := json.Unmarshal(data, value); err != nil {
				return err
			}
		} else {
			if err := json.Unmarshal(data, &value); err != nil {
				return err
			}
		}
		m.Args = append(m.Args, value)
	}
	return nil
}

// Unknown provider diagnostics are technical data inside a translatable wrapper.
func displayTextMessage(text string) *MessageInfo {
	if text == "" {
		return nil
	}
	if info := textMessage(text); info != nil {
		return info
	}
	return messageInfo("Operation failed: {0}", text)
}
func displayErrorMessage(err error) *MessageInfo {
	if info := errorMessage(err); info != nil {
		return info
	}
	if err == nil {
		return nil
	}
	return displayTextMessage(err.Error())
}
