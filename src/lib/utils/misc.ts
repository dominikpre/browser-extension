// https://learnersbucket.com/examples/javascript/unique-id-generator-in-javascript/
export const randomId = () => {
  let s4 = () =>
    Math.floor((1 + Math.random()) * 0x10000)
      .toString(16)
      .substring(1);
  //return id of format aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa
  return s4() + s4() + '-' + s4() + '-' + s4() + '-' + s4() + '-' + s4() + s4() + s4();
};
