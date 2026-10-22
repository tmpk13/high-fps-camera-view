//! Command parsing for the trigger board line protocol.
//!
//! Host to board, newline terminated, case insensitive command word:
//!   ARM | DISARM | TRIG | PULSE | STATUS | PING
//!   DELAY <ms> | PERIOD <ms> | FLASH <ms> | EDGE FALL|RISE|BOTH
#![cfg_attr(not(test), no_std)]

/// Largest accepted millisecond value, one hour.
pub const MAX_MS: u32 = 3_600_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Edge {
    Fall,
    Rise,
    Both,
}

impl Edge {
    pub fn name(self) -> &'static str {
        match self {
            Edge::Fall => "FALL",
            Edge::Rise => "RISE",
            Edge::Both => "BOTH",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Command {
    Ping,
    Status,
    Arm,
    Disarm,
    Trig,
    Pulse,
    Delay(u32),
    Period(u32),
    Flash(u32),
    Edge(Edge),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ParseError {
    Empty,
    Unknown,
    /// The command needs a millisecond argument from 0 to MAX_MS.
    NeedsMs,
    NeedsEdge,
}

impl ParseError {
    pub fn message(self) -> &'static str {
        match self {
            ParseError::Empty => "empty line",
            ParseError::Unknown => "unknown command",
            ParseError::NeedsMs => "needs milliseconds from 0 to 3600000",
            ParseError::NeedsEdge => "needs FALL, RISE or BOTH",
        }
    }
}

fn parse_ms(arg: Option<&str>) -> Result<u32, ParseError> {
    arg.and_then(|a| a.parse::<u32>().ok())
        .filter(|v| *v <= MAX_MS)
        .ok_or(ParseError::NeedsMs)
}

pub fn parse(line: &str) -> Result<Command, ParseError> {
    let mut parts = line.split_whitespace();
    let cmd = parts.next().ok_or(ParseError::Empty)?;
    let arg = parts.next();
    let is = |name: &str| cmd.eq_ignore_ascii_case(name);
    if is("PING") {
        Ok(Command::Ping)
    } else if is("STATUS") {
        Ok(Command::Status)
    } else if is("ARM") {
        Ok(Command::Arm)
    } else if is("DISARM") {
        Ok(Command::Disarm)
    } else if is("TRIG") {
        Ok(Command::Trig)
    } else if is("PULSE") {
        Ok(Command::Pulse)
    } else if is("DELAY") {
        parse_ms(arg).map(Command::Delay)
    } else if is("PERIOD") {
        parse_ms(arg).map(Command::Period)
    } else if is("FLASH") {
        parse_ms(arg).map(Command::Flash)
    } else if is("EDGE") {
        match arg {
            Some(a) if a.eq_ignore_ascii_case("FALL") => Ok(Command::Edge(Edge::Fall)),
            Some(a) if a.eq_ignore_ascii_case("RISE") => Ok(Command::Edge(Edge::Rise)),
            Some(a) if a.eq_ignore_ascii_case("BOTH") => Ok(Command::Edge(Edge::Both)),
            _ => Err(ParseError::NeedsEdge),
        }
    } else {
        Err(ParseError::Unknown)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_simple_commands_case_insensitively() {
        assert_eq!(parse("arm"), Ok(Command::Arm));
        assert_eq!(parse("DISARM  "), Ok(Command::Disarm));
        assert_eq!(parse("Ping"), Ok(Command::Ping));
        assert_eq!(parse("STATUS"), Ok(Command::Status));
        assert_eq!(parse("TRIG"), Ok(Command::Trig));
        assert_eq!(parse("PULSE"), Ok(Command::Pulse));
    }

    #[test]
    fn parses_millisecond_arguments() {
        assert_eq!(parse("DELAY 250"), Ok(Command::Delay(250)));
        assert_eq!(parse("period 0"), Ok(Command::Period(0)));
        assert_eq!(parse("FLASH 20"), Ok(Command::Flash(20)));
        assert_eq!(parse("DELAY"), Err(ParseError::NeedsMs));
        assert_eq!(parse("DELAY -1"), Err(ParseError::NeedsMs));
        assert_eq!(parse("DELAY 99999999"), Err(ParseError::NeedsMs));
    }

    #[test]
    fn parses_edges() {
        assert_eq!(parse("EDGE fall"), Ok(Command::Edge(Edge::Fall)));
        assert_eq!(parse("EDGE RISE"), Ok(Command::Edge(Edge::Rise)));
        assert_eq!(parse("EDGE both"), Ok(Command::Edge(Edge::Both)));
        assert_eq!(parse("EDGE up"), Err(ParseError::NeedsEdge));
    }

    #[test]
    fn rejects_junk() {
        assert_eq!(parse(""), Err(ParseError::Empty));
        assert_eq!(parse("   "), Err(ParseError::Empty));
        assert_eq!(parse("FIRE"), Err(ParseError::Unknown));
    }
}
