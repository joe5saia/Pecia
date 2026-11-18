// Good: a guard and an early return are not a branch on every case.
if (session.status === "landed") done();
if (session.status === "landed") done(); else retry();
// Good: two different questions.
if (session.status === "landed") done(); else if (session.owner === "amp") retry();
if (count > 1) many(); else if (count > 0) one();

// Bad: a branch on each case of one value.
switch (session.status) { case "landed": done(); } // expect: pecia/match-unions
if (session.status === "landed") done(); else if (session.status === "parked") park(); // expect: pecia/match-unions
if ("landed" === session.status) done(); else if (session.status === "parked") park(); else wait(); // expect: pecia/match-unions
