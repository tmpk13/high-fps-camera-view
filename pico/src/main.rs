//! Trigger board firmware for a Raspberry Pi Pico (RP2040).
//!
//! The board shows up as a USB serial port. It fires a trigger when its input
//! pin sees the configured edge, on a timer, or when the host asks, and
//! reports every trigger as a "TRIG" line so the capture server can end an
//! armed capture. A flash output pulses on each trigger so the moment is
//! visible in the video itself.
//!
//! Pins:
//!   GP2  trigger input, pulled up (button or open collector sensor to GND)
//!   GP3  flash output, active high (LED through a resistor, or a driver)
//!   GP4  sync output, 1 ms high pulse on every trigger
//!   GP25 on board LED: blinking idle, solid armed
//!
//! Line protocol, newline terminated, ASCII:
//!   host -> board: ARM | DISARM | TRIG | PULSE | STATUS | PING
//!                  DELAY <ms> | PERIOD <ms> | FLASH <ms> | EDGE FALL|RISE|BOTH
//!   board -> host: HELLO hfcv-trigger <version>
//!                  TRIG <count> <uptime_ms> <source>
//!                  STATUS armed=<0|1> delay=<ms> period=<ms> flash=<ms> edge=<FALL|RISE|BOTH> count=<n>
//!                  OK <command> | ERR <reason> | PONG

#![no_std]
#![no_main]

use core::cell::RefCell;
use core::fmt::Write as _;
use embassy_executor::Spawner;
use embassy_futures::select::{select, Either};
use embassy_rp::bind_interrupts;
use embassy_rp::gpio::{Input, Level, Output, Pull};
use embassy_rp::peripherals::USB;
use embassy_rp::usb::{Driver, InterruptHandler};
use embassy_sync::blocking_mutex::raw::CriticalSectionRawMutex;
use embassy_sync::blocking_mutex::Mutex;
use embassy_sync::channel::Channel;
use embassy_time::{Duration, Instant, Timer};
use embassy_usb::class::cdc_acm::{CdcAcmClass, Receiver, Sender, State};
use embassy_usb::{Builder, Config, UsbDevice};
use heapless::String;
use hfcv_protocol::{parse, Command, Edge};
use panic_halt as _;
use static_cell::StaticCell;

bind_interrupts!(struct Irqs {
    USBCTRL_IRQ => InterruptHandler<USB>;
});

const VERSION: &str = "1";
const DEBOUNCE_MS: u64 = 20;
const SYNC_PULSE_MS: u64 = 1;

#[derive(Clone, Copy)]
struct Settings {
    armed: bool,
    delay_ms: u32,
    period_ms: u32,
    flash_ms: u32,
    edge: Edge,
    count: u32,
}

impl Settings {
    const fn new() -> Self {
        Settings { armed: false, delay_ms: 0, period_ms: 0, flash_ms: 20, edge: Edge::Fall, count: 0 }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Source {
    Input,
    Timer,
    Host,
}

impl Source {
    fn name(self) -> &'static str {
        match self {
            Source::Input => "input",
            Source::Timer => "timer",
            Source::Host => "host",
        }
    }
}

enum Event {
    Trigger(Source),
    /// Flash without reporting a trigger, for checking the sync LED on camera.
    Pulse,
}

type Line = String<96>;

static SETTINGS: Mutex<CriticalSectionRawMutex, RefCell<Settings>> = Mutex::new(RefCell::new(Settings::new()));
static EVENTS: Channel<CriticalSectionRawMutex, Event, 8> = Channel::new();
static OUT: Channel<CriticalSectionRawMutex, Line, 16> = Channel::new();

fn settings() -> Settings {
    SETTINGS.lock(|s| *s.borrow())
}

fn update<F: FnOnce(&mut Settings)>(f: F) {
    SETTINGS.lock(|s| f(&mut s.borrow_mut()));
}

fn send_line(line: Line) {
    // Dropping a line when the host is not draining is better than stalling the trigger path.
    let _ = OUT.try_send(line);
}

fn status_line() -> Line {
    let s = settings();
    let mut l = Line::new();
    let _ = write!(
        l,
        "STATUS armed={} delay={} period={} flash={} edge={} count={}",
        s.armed as u8,
        s.delay_ms,
        s.period_ms,
        s.flash_ms,
        s.edge.name(),
        s.count
    );
    l
}

#[embassy_executor::main]
async fn main(spawner: Spawner) {
    let p = embassy_rp::init(Default::default());

    let driver = Driver::new(p.USB, Irqs);
    let mut config = Config::new(0x2e8a, 0x000a);
    config.manufacturer = Some("hfcv");
    config.product = Some("hfcv-trigger");
    config.serial_number = Some("hfcv-trigger-1");
    config.max_power = 100;
    config.max_packet_size_0 = 64;
    // CDC on Windows needs the composite class triple.
    config.device_class = 0xEF;
    config.device_sub_class = 0x02;
    config.device_protocol = 0x01;
    config.composite_with_iads = true;

    static CONFIG_DESC: StaticCell<[u8; 256]> = StaticCell::new();
    static BOS_DESC: StaticCell<[u8; 256]> = StaticCell::new();
    static MSOS_DESC: StaticCell<[u8; 256]> = StaticCell::new();
    static CONTROL_BUF: StaticCell<[u8; 64]> = StaticCell::new();
    static STATE: StaticCell<State> = StaticCell::new();

    let mut builder = Builder::new(
        driver,
        config,
        CONFIG_DESC.init([0; 256]),
        BOS_DESC.init([0; 256]),
        MSOS_DESC.init([0; 256]),
        CONTROL_BUF.init([0; 64]),
    );
    let class = CdcAcmClass::new(&mut builder, STATE.init(State::new()), 64);
    let usb = builder.build();
    let (sender, receiver) = class.split();

    spawner.spawn(usb_task(usb).unwrap());
    spawner.spawn(cdc_reader(receiver).unwrap());
    spawner.spawn(cdc_writer(sender).unwrap());
    spawner.spawn(input_task(Input::new(p.PIN_2, Pull::Up)).unwrap());
    spawner.spawn(periodic_task().unwrap());
    spawner.spawn(trigger_task(Output::new(p.PIN_3, Level::Low), Output::new(p.PIN_4, Level::Low)).unwrap());
    spawner.spawn(led_task(Output::new(p.PIN_25, Level::Low)).unwrap());
}

#[embassy_executor::task]
async fn usb_task(mut usb: UsbDevice<'static, Driver<'static, USB>>) {
    usb.run().await;
}

#[embassy_executor::task]
async fn cdc_writer(mut tx: Sender<'static, Driver<'static, USB>>) {
    loop {
        tx.wait_connection().await;
        let mut hello = Line::new();
        let _ = write!(hello, "HELLO hfcv-trigger {VERSION}");
        let _ = write_line(&mut tx, &hello).await;
        loop {
            let line = OUT.receive().await;
            if write_line(&mut tx, &line).await.is_err() {
                break;
            }
        }
    }
}

async fn write_line(tx: &mut Sender<'static, Driver<'static, USB>>, line: &Line) -> Result<(), ()> {
    let max = tx.max_packet_size() as usize;
    let mut buf: String<98> = String::new();
    let _ = buf.push_str(line);
    let _ = buf.push('\n');
    let bytes = buf.as_bytes();
    for chunk in bytes.chunks(max) {
        tx.write_packet(chunk).await.map_err(|_| ())?;
    }
    // A payload that is a whole number of packets needs a zero length packet to flush.
    if bytes.len() % max == 0 {
        tx.write_packet(&[]).await.map_err(|_| ())?;
    }
    Ok(())
}

#[embassy_executor::task]
async fn cdc_reader(mut rx: Receiver<'static, Driver<'static, USB>>) {
    let mut line: String<64> = String::new();
    loop {
        rx.wait_connection().await;
        line.clear();
        let mut buf = [0u8; 64];
        loop {
            let n = match rx.read_packet(&mut buf).await {
                Ok(n) => n,
                Err(_) => break,
            };
            for &b in &buf[..n] {
                match b {
                    b'\n' | b'\r' => {
                        if !line.is_empty() {
                            handle_command(line.trim());
                            line.clear();
                        }
                    }
                    _ => {
                        if line.push(b as char).is_err() {
                            line.clear();
                            send_line(err("line too long"));
                        }
                    }
                }
            }
        }
    }
}

fn ok(cmd: &str) -> Line {
    let mut l = Line::new();
    let _ = write!(l, "OK {cmd}");
    l
}

fn err(reason: &str) -> Line {
    let mut l = Line::new();
    let _ = write!(l, "ERR {reason}");
    l
}

fn handle_command(text: &str) {
    let cmd = match parse(text) {
        Ok(cmd) => cmd,
        Err(e) => {
            send_line(err(e.message()));
            return;
        }
    };
    match cmd {
        Command::Ping => {
            let mut l = Line::new();
            let _ = l.push_str("PONG");
            send_line(l);
        }
        Command::Status => send_line(status_line()),
        Command::Arm => {
            update(|s| s.armed = true);
            send_line(ok("ARM"));
        }
        Command::Disarm => {
            update(|s| s.armed = false);
            send_line(ok("DISARM"));
        }
        Command::Trig => {
            let _ = EVENTS.try_send(Event::Trigger(Source::Host));
        }
        Command::Pulse => {
            let _ = EVENTS.try_send(Event::Pulse);
            send_line(ok("PULSE"));
        }
        Command::Delay(v) => {
            update(|s| s.delay_ms = v);
            send_line(ok("DELAY"));
        }
        Command::Period(v) => {
            update(|s| s.period_ms = v);
            send_line(ok("PERIOD"));
        }
        Command::Flash(v) => {
            update(|s| s.flash_ms = v);
            send_line(ok("FLASH"));
        }
        Command::Edge(e) => {
            update(|s| s.edge = e);
            send_line(ok("EDGE"));
        }
    }
}

/// Watches the input pin and fires on the configured edge after a debounce.
#[embassy_executor::task]
async fn input_task(mut pin: Input<'static>) {
    loop {
        pin.wait_for_any_edge().await;
        let level_after_edge = pin.is_high();
        Timer::after(Duration::from_millis(DEBOUNCE_MS)).await;
        if pin.is_high() != level_after_edge {
            continue;
        }
        let s = settings();
        let wanted = match s.edge {
            Edge::Fall => !level_after_edge,
            Edge::Rise => level_after_edge,
            Edge::Both => true,
        };
        if wanted && s.armed {
            let _ = EVENTS.try_send(Event::Trigger(Source::Input));
        }
    }
}

/// Fires on a fixed period while armed and a period is set.
#[embassy_executor::task]
async fn periodic_task() {
    loop {
        let s = settings();
        if !s.armed || s.period_ms == 0 {
            Timer::after(Duration::from_millis(100)).await;
            continue;
        }
        Timer::after(Duration::from_millis(s.period_ms as u64)).await;
        let now = settings();
        if now.armed && now.period_ms != 0 {
            let _ = EVENTS.try_send(Event::Trigger(Source::Timer));
        }
    }
}

/// Applies the delay, drives the flash and sync outputs and reports the trigger.
#[embassy_executor::task]
async fn trigger_task(mut flash: Output<'static>, mut sync: Output<'static>) {
    loop {
        let event = EVENTS.receive().await;
        let s = settings();
        match event {
            Event::Trigger(source) => {
                if s.delay_ms > 0 {
                    Timer::after(Duration::from_millis(s.delay_ms as u64)).await;
                }
                let count = SETTINGS.lock(|c| {
                    let mut c = c.borrow_mut();
                    c.count += 1;
                    c.count
                });
                let uptime = Instant::now().as_millis();
                let mut l = Line::new();
                let _ = write!(l, "TRIG {count} {uptime} {}", source.name());
                send_line(l);
                pulse(&mut flash, &mut sync, s.flash_ms).await;
            }
            Event::Pulse => pulse(&mut flash, &mut sync, s.flash_ms).await,
        }
    }
}

async fn pulse(flash: &mut Output<'static>, sync: &mut Output<'static>, flash_ms: u32) {
    sync.set_high();
    if flash_ms > 0 {
        flash.set_high();
    }
    let flash_wait = Timer::after(Duration::from_millis(flash_ms as u64));
    let sync_wait = Timer::after(Duration::from_millis(SYNC_PULSE_MS));
    match select(flash_wait, sync_wait).await {
        Either::First(_) => {
            flash.set_low();
            Timer::after(Duration::from_millis(SYNC_PULSE_MS)).await;
            sync.set_low();
        }
        Either::Second(_) => {
            sync.set_low();
            if flash_ms > SYNC_PULSE_MS as u32 {
                Timer::after(Duration::from_millis(flash_ms as u64 - SYNC_PULSE_MS)).await;
            }
            flash.set_low();
        }
    }
}

/// On board LED: slow blink while idle, solid while armed.
#[embassy_executor::task]
async fn led_task(mut led: Output<'static>) {
    loop {
        if settings().armed {
            led.set_high();
            Timer::after(Duration::from_millis(100)).await;
        } else {
            led.set_high();
            Timer::after(Duration::from_millis(50)).await;
            led.set_low();
            Timer::after(Duration::from_millis(950)).await;
        }
    }
}
